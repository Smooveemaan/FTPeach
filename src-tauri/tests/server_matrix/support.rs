//! Selection, per-server serialisation, connections and remote helpers shared
//! by the scenarios.

use crate::targets::{Kind, Target, target};
use app_lib::protocol::config::ConnectionConfig;
use app_lib::protocol::ftp::FtpBackend;
use app_lib::protocol::sftp::SftpBackend;
use app_lib::protocol::webdav::WebDavBackend;
use app_lib::protocol::{EntryInfo, ProgressSink, ProtocolBackend};
use app_lib::store::Store;
use app_lib::{CommandError, ErrorCode};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

pub type Backend = Box<dyn ProtocolBackend + Send>;
pub type Scenario = Pin<Box<dyn Future<Output = ()> + Send>>;

fn listed(variable: &str) -> Option<Vec<String>> {
    let value = std::env::var(variable).ok()?;
    Some(
        value
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
    )
}

fn selected(target: &Target) -> bool {
    let profiles = listed("FTPEACH_MATRIX");
    let targets = listed("FTPEACH_MATRIX_TARGETS");
    // IIS changes the Windows host (iis.ps1), so it runs only when named.
    let host_only = target.profile == "iis";
    if profiles.is_none() && targets.is_none() {
        return !host_only;
    }
    profiles.is_some_and(|list| {
        list.iter()
            .any(|p| (p == "all" && !host_only) || p == target.profile)
    }) || targets.is_some_and(|list| list.iter().any(|id| id == target.id))
}

/// One lock per container, shared by every target it serves.
type ServiceLocks = Mutex<HashMap<&'static str, Arc<tokio::sync::Mutex<()>>>>;

static SERVICE_LOCKS: LazyLock<ServiceLocks> = LazyLock::new(Default::default);

fn timeout() -> Duration {
    Duration::from_secs(
        std::env::var("FTPEACH_MATRIX_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(300),
    )
}

pub async fn run(id: &str, scenario: impl FnOnce(Target) -> Scenario) {
    let target = target(id);
    if !selected(&target) {
        println!("NOT RUN: {id} is not selected by FTPEACH_MATRIX / FTPEACH_MATRIX_TARGETS");
        return;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let lock = SERVICE_LOCKS
        .lock()
        .unwrap()
        .entry(target.service)
        .or_default()
        .clone();
    let _guard = lock.lock().await;
    tokio::time::timeout(timeout(), scenario(target))
        .await
        .unwrap_or_else(|_| panic!("{id}: scenario timed out after {:?}", timeout()));
}

pub fn code(error: &anyhow::Error) -> ErrorCode {
    CommandError::from_anyhow(error).code
}

pub fn noop_progress() -> ProgressSink {
    Arc::new(|_| {})
}

pub fn parse(config: &Map<String, Value>) -> ConnectionConfig {
    ConnectionConfig::from_json_map(config).expect("valid matrix config")
}

/// A backend for the target's kind. SFTP pins host keys in a throwaway store.
pub fn backend(kind: Kind) -> Backend {
    match kind {
        Kind::Ftp => Box::new(FtpBackend::new()),
        Kind::Sftp => Box::new(SftpBackend::new(Arc::new(Store::new_at(
            std::env::temp_dir().join(format!("ftpeach-matrix-store-{}", uuid::Uuid::new_v4())),
        )))),
        Kind::Webdav => Box::new(WebDavBackend::new()),
    }
}

pub async fn try_connect_with(
    target: &Target,
    config: &Map<String, Value>,
) -> anyhow::Result<Backend> {
    let mut backend = backend(target.kind);
    backend.connect(&parse(config)).await?;
    Ok(backend)
}

pub async fn connect(target: &Target) -> Backend {
    try_connect_with(target, &target.config)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{}: connect failed [{:?}]: {error:#}",
                target.id,
                code(&error)
            )
        })
}

pub fn join(parent: &str, name: &str) -> String {
    format!("{}/{name}", parent.trim_end_matches('/'))
}

/// The size the seed gave `fixtures/sizes/big.bin` on this server, read from
/// its marker: a server seeded with another `BIG_MB` still checks out.
pub async fn seeded_big_bytes(backend: &mut Backend, target: &Target) -> u64 {
    let mut marker = Vec::new();
    let seeded = backend
        .download_to_writer(&join(target.root, ".ftpeach-seed"), &mut marker)
        .await
        .ok()
        .and_then(|()| {
            String::from_utf8_lossy(&marker)
                .split_whitespace()
                .find_map(|field| field.strip_prefix("big_mb="))
                .and_then(|mb| mb.parse::<u64>().ok())
        });
    seeded.map_or_else(crate::targets::big_bytes, |mb| mb * 1024 * 1024)
}

pub fn fixtures(target: &Target, path: &str) -> String {
    join(&join(target.root, "fixtures"), path)
}

pub fn names(entries: &[EntryInfo]) -> Vec<&str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

pub fn find<'a>(entries: &'a [EntryInfo], name: &str) -> Option<&'a EntryInfo> {
    entries.iter().find(|entry| entry.name == name)
}

/// A per-run remote directory next to `fixtures/`, plus a local scratch
/// directory. Removed at the end of a passing scenario; a failing one leaves
/// it for inspection, and it never collides with the next run.
pub struct Work {
    pub remote: String,
    pub local: PathBuf,
}

impl Work {
    pub async fn new(target: &Target, backend: &mut Backend) -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let remote = join(target.root, &format!("ftpeach-matrix-{}", &id[..12]));
        backend
            .mkdir(&remote)
            .await
            .unwrap_or_else(|error| panic!("{}: mkdir {remote}: {error:#}", target.id));
        let local = std::env::temp_dir().join(format!("ftpeach-matrix-{id}"));
        tokio::fs::create_dir_all(&local).await.unwrap();
        Self { remote, local }
    }

    pub fn path(&self, name: &str) -> String {
        join(&self.remote, name)
    }

    pub fn local(&self, name: &str) -> PathBuf {
        self.local.join(name)
    }

    pub async fn finish(self, backend: &mut Backend) {
        remove_tree(backend, &self.remote)
            .await
            .unwrap_or_else(|error| panic!("cleanup {}: {error:#}", self.remote));
        let _ = tokio::fs::remove_dir_all(&self.local).await;
    }
}

pub async fn put(backend: &mut Backend, local: &Path, remote: &str, content: &[u8]) {
    tokio::fs::write(local, content).await.unwrap();
    backend
        .upload(local, remote, false, noop_progress())
        .await
        .unwrap_or_else(|error| panic!("upload {remote} [{:?}]: {error:#}", code(&error)));
}

pub async fn get(backend: &mut Backend, remote: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    backend
        .download_to_writer(remote, &mut bytes)
        .await
        .unwrap_or_else(|error| panic!("download {remote} [{:?}]: {error:#}", code(&error)));
    bytes
}

/// Depth-first removal with the backend's own primitives, as the app's
/// recursive delete does.
pub fn remove_tree<'a>(
    backend: &'a mut Backend,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        for entry in backend.list_for_recursive(path).await? {
            let child = join(path, &entry.name);
            if entry.is_directory {
                remove_tree(backend, &child).await?;
            } else {
                backend.remove(&child, false).await?;
            }
        }
        backend.remove(path, true).await
    })
}
