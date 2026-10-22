mod backend_logger;
mod failure;
pub use failure::fail;
mod limits;
pub use limits::{MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_TEXT_BYTES, MAX_RAW_DIRECTORY_ENTRIES};
pub mod config;
pub mod ftp;
pub(crate) mod ftp_charset;
pub mod known_hosts;
mod remote_path;
pub use remote_path::{MAX_REMOTE_PATH_LEN, validate_remote_path, validate_remote_relationship};
mod list_parse;
mod proxy;
pub mod sftp;
mod socks_bridge;
pub mod transfer_file;
pub mod transport;
pub mod webdav;

use async_trait::async_trait;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};

// Secrets are the security zone's business; the protocol layer only
// carries them. Re-exported under the name its own modules already use.
pub use crate::security::sensitive_string::SensitiveString;

/// Every backend operation reports failure as an `anyhow::Error`, because a
/// driver mostly forwards whatever its protocol crate produced. What the app
/// itself decides — "this was a timeout", "the user cancelled" — is carried
/// as a typed [`crate::ipc::CommandError`] inside that error; build those with
/// [`fail`] so both classification points read the code rather than the text.
pub type BackendResult<T> = anyhow::Result<T>;

#[cfg(test)]
mod secret_formatting_tests {
    use crate::protocol::config::ConnectionConfig;

    const MARKER: &str = "ftpeach-secret-marker";

    fn config(value: serde_json::Value) -> ConnectionConfig {
        ConnectionConfig::for_test(value.as_object().unwrap()).unwrap()
    }

    /// A `Debug` derive on a struct holding a `String` password is one
    /// `{config:?}` away from a password in the log file, and the types that
    /// hold one are ordinary enough to be printed that way by accident.
    #[test]
    fn no_real_config_type_prints_its_secrets() {
        let proxy = serde_json::json!({
            "proxyEnabled": true,
            "proxyType": "socks5",
            "proxyHost": "proxy.test",
            "proxyPort": 1080,
            "proxyUsername": "alice",
            "proxyPassword": MARKER,
        });
        let mut ftp = proxy.clone();
        let mut sftp = proxy.clone();
        let mut webdav = proxy;
        for (target, extra) in [
            (
                &mut ftp,
                serde_json::json!({ "protocol": "ftp", "host": "ftp.test", "password": MARKER }),
            ),
            (
                &mut sftp,
                serde_json::json!({
                    "protocol": "sftp",
                    "host": "sftp.test",
                    "password": MARKER,
                    "keyPassphrase": MARKER,
                }),
            ),
            (
                &mut webdav,
                serde_json::json!({
                    "protocol": "webdav",
                    "webdavUrl": "https://dav.test/remote",
                    "password": MARKER,
                }),
            ),
        ] {
            for (key, value) in extra.as_object().unwrap() {
                target
                    .as_object_mut()
                    .unwrap()
                    .insert(key.clone(), value.clone());
            }
        }

        for value in [ftp, sftp, webdav] {
            let typed = config(value);
            let printed = format!("{typed:?}");
            assert!(!printed.contains(MARKER), "{printed}");
            // The proxy rides inside the same config; print it on its own
            // too, since that is how a handshake failure would report it.
            let proxy = typed.common().proxy.clone().expect("proxy");
            assert!(!format!("{proxy:?}").contains(MARKER));
        }
    }
}

#[cfg(test)]
mod stranded_tests {
    use super::*;

    #[test]
    fn a_stranded_replacement_outlives_a_restart_and_a_foreign_record_does_not() {
        let dir = std::env::temp_dir().join(format!("ftpeach-stranded-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stranded-replacements.json");
        let server = format!("server {}", uuid::Uuid::new_v4());
        let staging = format!("/up/.ftpeach-{}.part", uuid::Uuid::new_v4());
        let aside = format!("/up/.ftpeach-{}.old", uuid::Uuid::new_v4());
        SET_ASIDE.lock().unwrap().insert(
            staging.clone(),
            SetAside {
                aside: aside.clone(),
                name: "/up/file".into(),
                stranded_on: None,
            },
        );
        assert!(strand_set_aside(&staging, &server));
        write_stranded(&path).unwrap();

        // The next run starts with an empty map.
        SET_ASIDE.lock().unwrap().remove(&staging);
        load_stranded(&path);
        assert_eq!(stranded_on(&server), std::slice::from_ref(&staging));
        assert_eq!(SET_ASIDE.lock().unwrap()[&staging].aside, aside);

        // Settled, it leaves the file; the last one takes the file with it.
        SET_ASIDE.lock().unwrap().remove(&staging);
        write_stranded(&path).unwrap();
        let left: Vec<Stranded> = std::fs::read(&path)
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
            .unwrap_or_default();
        assert!(left.iter().all(|record| record.staging != staging));

        // A record that would rename or delete someone else's file is dropped.
        let foreign = serde_json::json!([
            { "server": server, "staging": "/up/report.pdf", "aside": aside, "name": "/up/file" },
            { "server": server, "staging": staging, "aside": "/other/.ftpeach-x.old", "name": "/up/file" },
        ]);
        std::fs::write(&path, foreign.to_string()).unwrap();
        load_stranded(&path);
        assert!(stranded_on(&server).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

pub const MAX_REMOTE_FILENAME_LEN: usize = 1024;
tokio::task_local! { pub static ALLOW_OVERWRITE: bool; }

pub fn overwrite_allowed() -> bool {
    ALLOW_OVERWRITE.try_with(|value| *value).unwrap_or(false)
}

/// Puts `old_path` in place of the file at `new_path` on a server that will
/// not rename over an existing file. That file is renamed aside to a hidden
/// sibling rather than deleted, so one version stands at a name at every
/// step: if the new file cannot take its place, the old one is put back, and
/// it is removed only once the new one is in. A stop or a lost connection
/// between the two renames leaves it under the hidden name, recorded for
/// [`put_back_set_aside`].
pub(crate) async fn replace_by_setting_aside<B: ProtocolBackend + ?Sized>(
    backend: &mut B,
    old_path: &str,
    new_path: &str,
) -> BackendResult<()> {
    let parent = new_path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(".");
    let aside = format!("{parent}/.ftpeach-{}.old", uuid::Uuid::new_v4());
    if let Err(error) = backend.rename_no_replace(new_path, &aside).await {
        return Err(refused_replacement(error, new_path));
    }
    SET_ASIDE.lock().unwrap().insert(
        old_path.to_owned(),
        SetAside {
            aside: aside.clone(),
            name: new_path.to_owned(),
            stranded_on: None,
        },
    );
    let settled = || settle(old_path);
    let Err(error) = backend.rename_no_replace(old_path, new_path).await else {
        settled();
        if let Err(error) = backend.remove(&aside, false).await {
            log::warn!(
                "Replaced {new_path}, but could not remove its previous version {aside}: {error:#}"
            );
        }
        return Ok(());
    };
    if let Err(restore) = backend.rename_no_replace(&aside, new_path).await {
        log::error!("Could not put {aside} back as {new_path}: {restore:#}");
        return Err(error.context(format!(
            "The previous version of {new_path} is kept as {aside}"
        )));
    }
    settled();
    Err(refused_replacement(error, new_path))
}

/// A replacement that stopped between its two renames, by the file that was to
/// take the name.
struct SetAside {
    /// The hidden name the old file was given.
    aside: String,
    /// The name it is to go back to.
    name: String,
    /// The server, once no connection there could put it back: the next one
    /// to it does.
    stranded_on: Option<String>,
}

// ponytail: process-wide map keyed by remote path. Only stranded entries are
// kept on disk; a crash between the two renames themselves still leaves the
// old file under its hidden name.
static SET_ASIDE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, SetAside>>,
> = std::sync::LazyLock::new(Default::default);

/// Where stranded replacements are kept while FTPeach is closed.
static STRANDED_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// How many stranded replacements a file kept between runs may name.
const MAX_STRANDED: usize = 1024;

/// A stranded replacement as it is kept between runs.
#[derive(Serialize, serde::Deserialize)]
struct Stranded {
    server: String,
    staging: String,
    aside: String,
    name: String,
}

impl Stranded {
    /// Only what a replacement itself would have written: a staging file and
    /// a set-aside file of FTPeach's own naming, both beside the name. A record
    /// that names anything else would rename or delete a file FTPeach did not
    /// make.
    fn is_own(&self) -> bool {
        let split = |path: &str| {
            path.rsplit_once('/')
                .map(|(parent, base)| (parent.to_owned(), base.to_owned()))
        };
        let own = |base: &str, suffix: &str| {
            base.strip_prefix(".ftpeach-")
                .and_then(|rest| rest.strip_suffix(suffix))
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        };
        let (Some((parent, _)), Some((staging_parent, staging)), Some((aside_parent, aside))) =
            (split(&self.name), split(&self.staging), split(&self.aside))
        else {
            return false;
        };
        parent == staging_parent
            && parent == aside_parent
            && own(&staging, ".part")
            && own(&aside, ".old")
    }
}

/// Keeps replacements left for the next connection in `data_dir`, and takes
/// back those an earlier run left there, so closing FTPeach before that
/// connection does not lose the way back to a set-aside file.
pub fn keep_stranded_in(data_dir: &Path) {
    let path = data_dir.join("stranded-replacements.json");
    load_stranded(&path);
    let _ = STRANDED_FILE.set(path);
}

fn load_stranded(path: &Path) {
    let records: Vec<Stranded> = match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(records) => records,
            Err(error) => {
                log::warn!("Ignored {}: {error}", path.display());
                return;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!("Could not read {}: {error}", path.display());
            return;
        }
    };
    let mut map = SET_ASIDE.lock().unwrap();
    for record in records.into_iter().take(MAX_STRANDED) {
        if !record.is_own() {
            log::warn!(
                "Ignored a stranded replacement of {} that names files FTPeach did not make",
                record.name
            );
            continue;
        }
        map.entry(record.staging).or_insert(SetAside {
            aside: record.aside,
            name: record.name,
            stranded_on: Some(record.server),
        });
    }
}

fn write_stranded(path: &Path) -> std::io::Result<()> {
    let records: Vec<Stranded> = SET_ASIDE
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(staging, entry)| {
            Some(Stranded {
                server: entry.stranded_on.clone()?,
                staging: staging.clone(),
                aside: entry.aside.clone(),
                name: entry.name.clone(),
            })
        })
        .take(MAX_STRANDED)
        .collect();
    if records.is_empty() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&records)?)?;
    std::fs::rename(&tmp, path)
}

/// Brings the kept stranded replacements up to date with the map.
fn save_stranded() {
    // One writer at a time, so an older snapshot never lands after a newer one.
    static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if let Some(path) = STRANDED_FILE.get() {
        let _saving = SAVING.lock().unwrap();
        if let Err(error) = write_stranded(path) {
            log::warn!(
                "Could not keep stranded replacements in {}: {error}",
                path.display()
            );
        }
    }
}

/// Forgets the replacement by `staging`, on disk too when it was stranded.
fn settle(staging: &str) -> Option<SetAside> {
    let entry = SET_ASIDE.lock().unwrap().remove(staging);
    if entry
        .as_ref()
        .is_some_and(|entry| entry.stranded_on.is_some())
    {
        save_stranded();
    }
    entry
}

/// Before `staging` is deleted: puts back the file a replacement by it set
/// aside and did not get to put back itself, over a connection that still
/// works. False when that failed: the staging file has to stay, since it may be
/// the only copy of the new version while the old one is still hidden. The
/// record stays for another try, unless something else has taken the name.
pub(crate) async fn put_back_set_aside<B: ProtocolBackend + ?Sized>(
    backend: &mut B,
    staging: &str,
) -> bool {
    let Some((aside, name)) = SET_ASIDE
        .lock()
        .unwrap()
        .get(staging)
        .map(|entry| (entry.aside.clone(), entry.name.clone()))
    else {
        return true;
    };
    let put_back = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        backend.rename_no_replace(&aside, &name),
    )
    .await;
    match put_back {
        Ok(Ok(())) => {
            settle(staging);
            log::warn!("Put {aside} back as {name}: replacing it with {staging} was cut off");
            return true;
        }
        Ok(Err(error))
            if crate::ipc::CommandError::from_anyhow(&error).code
                == crate::ipc::ErrorCode::AlreadyExists =>
        {
            settle(staging);
            log::error!("{name} is taken again; kept its previous version {aside} and {staging}");
        }
        Ok(Err(error))
            if crate::ipc::CommandError::from_anyhow(&error).code
                == crate::ipc::ErrorCode::NotFound =>
        {
            settle(staging);
            log::error!(
                "{aside} is gone, so there is nothing to put back as {name}; kept {staging}"
            );
        }
        Ok(Err(error)) => {
            log::error!("Could not put {aside} back as {name}, kept it and {staging}: {error:#}");
        }
        Err(_) => log::error!("Timed out putting {aside} back as {name}, kept it and {staging}"),
    }
    false
}

/// Once cleanup has had its try: marks a file `staging` set aside that is
/// still waiting to be put back as left on `server`, for the next connection
/// there. Says whether there is one.
pub(crate) fn strand_set_aside(staging: &str, server: &str) -> bool {
    let stranded = SET_ASIDE
        .lock()
        .unwrap()
        .get_mut(staging)
        .map(|entry| entry.stranded_on = Some(server.to_owned()))
        .is_some();
    if stranded {
        save_stranded();
    }
    stranded
}

/// The staging files whose set-aside file waits on `server` to be put back.
pub(crate) fn stranded_on(server: &str) -> Vec<String> {
    SET_ASIDE
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry.stranded_on.as_deref() == Some(server))
        .map(|(staging, _)| staging.clone())
        .collect()
}

/// After `staging` has taken its name: removes the file it replaced that an
/// earlier attempt set aside, when a pause came between the two renames.
pub(crate) async fn remove_set_aside<B: ProtocolBackend + ?Sized>(backend: &mut B, staging: &str) {
    let Some(entry) = settle(staging) else {
        return;
    };
    if let Err(error) = backend.remove(&entry.aside, false).await {
        log::warn!(
            "Replaced {}, but could not remove its previous version {}: {error:#}",
            entry.name,
            entry.aside
        );
    }
}

/// A refusal the server gave no reason for is named for what it refused.
fn refused_replacement(error: anyhow::Error, new_path: &str) -> anyhow::Error {
    if !crate::ipc::CommandError::unexplained(&error) {
        return error;
    }
    fail(
        crate::ipc::ErrorCode::ReplaceUnsupported,
        format!("The server did not let {new_path} be replaced: {error:#}"),
    )
}

pub fn validate_listing(entries: &[EntryInfo]) -> BackendResult<()> {
    let mut text_bytes = 0usize;
    if entries.len() > MAX_DIRECTORY_ENTRIES {
        anyhow::bail!(crate::ipc::CommandError::new(
            crate::ipc::ErrorCode::ResourceLimit,
            "Remote directory contains too many entries",
        ));
    }
    for entry in entries {
        if entry.name.len() > MAX_REMOTE_FILENAME_LEN {
            anyhow::bail!(crate::ipc::CommandError::new(
                crate::ipc::ErrorCode::ResourceLimit,
                "Remote filename exceeds the 1024-byte limit",
            ));
        }
        text_bytes = text_bytes.saturating_add(entry.name.len());
        if text_bytes > MAX_DIRECTORY_TEXT_BYTES {
            anyhow::bail!(crate::ipc::CommandError::new(
                crate::ipc::ErrorCode::ResourceLimit,
                format!(
                    "Remote directory listing exceeds the {} MiB text limit",
                    MAX_DIRECTORY_TEXT_BYTES >> 20
                ),
            ));
        }
    }
    Ok(())
}

/// Classifies each log line for the "Log" panel (the renderer colors by
/// this), loosely mirroring FileZilla's own status/command/response/error
/// distinction. No "listing"/"debug" kinds: unlike FileZilla's basic-ftp-style
/// wire trace, these backends only ever emit friendly, higher-level lines
/// (see ftp.rs's module doc), so there's no raw-listing or debug tier to
/// distinguish.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Status,
    Command,
    Response,
    Error,
}

/// Either literal protocol wire text (a raw FTP/WebDAV command, a server's
/// numeric-coded reply body, ...) which is inherently non-prose and never
/// translated — same convention FileZilla's own log follows — or a
/// translation key + interpolation params for a human-authored sentence
/// ("Connecting to...", "Received N entries"), resolved by the frontend via
/// i18next (`log.{key}`). `From<String>`/`From<&str>` produce `Raw`, so every
/// existing `self.log_kind(format!(...), kind)` call site needs no change.
#[derive(Clone)]
pub enum LogText {
    Raw(String),
    Key {
        key: &'static str,
        params: serde_json::Value,
    },
}

impl LogText {
    pub fn event(key: &'static str, params: serde_json::Value) -> Self {
        Self::Key {
            key,
            params: sanitize_event_value(params, None),
        }
    }
}

fn sanitize_event_value(value: serde_json::Value, field: Option<&str>) -> serde_json::Value {
    use serde_json::Value;
    let sensitive = field.is_some_and(|name| {
        let name = name.to_ascii_lowercase().replace(['-', '_'], "");
        [
            "password",
            "passwd",
            "passphrase",
            "authorization",
            "privatekey",
            "token",
            "secret",
            "apikey",
        ]
        .iter()
        .any(|part| name.contains(part))
    });
    if sensitive {
        return Value::String("[REDACTED]".into());
    }
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let value = sanitize_event_value(value, Some(&key));
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| sanitize_event_value(value, field))
                .collect(),
        ),
        Value::String(value) => Value::String(crate::security::redaction::redact(&value)),
        other => other,
    }
}

impl From<String> for LogText {
    fn from(s: String) -> Self {
        LogText::Raw(s)
    }
}

impl From<&str> for LogText {
    fn from(s: &str) -> Self {
        LogText::Raw(s.to_string())
    }
}

#[cfg(test)]
mod log_safety_tests {
    use super::*;

    #[test]
    fn a_listing_over_the_text_limit_names_the_real_limit() {
        let entry = EntryInfo {
            name: "x".repeat(1024),
            is_directory: false,
            size: 0,
            modified_at: None,
            permissions: None,
            owner: None,
            group: None,
        };
        let entries = vec![entry; MAX_DIRECTORY_TEXT_BYTES / 1024 + 1];
        let error = crate::ipc::CommandError::from_anyhow(&validate_listing(&entries).unwrap_err());
        assert_eq!(error.code, crate::ipc::ErrorCode::ResourceLimit);
        assert_eq!(
            error.message,
            "Remote directory listing exceeds the 32 MiB text limit"
        );
    }

    #[test]
    fn remote_moves_reject_self_and_descendants_before_server_mutation() {
        for target in [
            "/data/folder",
            "/data/folder/child",
            "/data/folder/deep/child",
            "/DATA/FOLDER/child",
            r"\data\folder\child",
            "/data/folder/../folder/child",
        ] {
            assert!(
                validate_remote_relationship("/data/folder", target).is_err(),
                "{target}"
            );
        }
        assert!(validate_remote_relationship("/data/folder", "/data/folder-other").is_ok());
    }

    #[test]
    fn a_case_only_rename_is_not_a_move_into_itself() {
        assert!(validate_remote_relationship("/data/a.txt", "/data/A.txt").is_ok());
        assert!(validate_remote_relationship("/data/folder", "/DATA/FOLDER").is_err());
        let error = validate_remote_relationship("/data/folder", "/data/folder/child").unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::InsideSource
        );
    }

    #[test]
    fn sensitive_values_and_event_fields_are_never_formatted_verbatim() {
        let secret = SensitiveString::from("known-secret");
        assert_eq!(format!("{secret:?}"), "[REDACTED]");
        assert_eq!(secret.expose(), "known-secret");

        let LogText::Key { params, .. } = LogText::event(
            "example",
            serde_json::json!({"authorization":"Bearer known-secret", "nested":{"private_key":"known-secret"}}),
        ) else {
            panic!("expected structured event")
        };
        assert!(!params.to_string().contains("known-secret"));
    }

    #[test]
    fn listing_and_path_limits_have_stable_boundaries() {
        assert!(validate_remote_path(&"x".repeat(MAX_REMOTE_PATH_LEN)).is_ok());
        assert!(validate_remote_path(&"x".repeat(MAX_REMOTE_PATH_LEN + 1)).is_err());
        let entry = |name: String| EntryInfo {
            name,
            is_directory: false,
            size: 0,
            modified_at: None,
            permissions: None,
            owner: None,
            group: None,
        };
        assert!(validate_listing(&[entry("x".repeat(MAX_REMOTE_FILENAME_LEN))]).is_ok());
        assert!(validate_listing(&[entry("x".repeat(MAX_REMOTE_FILENAME_LEN + 1))]).is_err());
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_at: Option<String>,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ProgressInfo {
    #[serde(rename = "progress")]
    Progress { bytes: u64, total: u64 },
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error {
        error: String,
        /// Classified once, here at the driver, from the typed error itself —
        /// so the category the renderer receives doesn't depend on the
        /// sentence surviving unchanged all the way to the command layer.
        code: crate::ipc::ErrorCode,
    },
}

impl ProgressInfo {
    /// The single way a driver reports a failed transfer: renders the error
    /// for the log and classifies it from the typed error, not from the text.
    pub fn failed(error: &anyhow::Error) -> Self {
        Self::Error {
            error: format!("{error:#}"),
            code: crate::ipc::CommandError::from_anyhow(error).code,
        }
    }
}

/// Progress callback threaded through every [`ProtocolBackend`]
/// upload/download operation; backends call it once per transferred chunk.
pub type ProgressSink = Arc<dyn Fn(ProgressInfo) + Send + Sync>;

#[async_trait]
pub trait ProtocolBackend: Send {
    async fn connect(&mut self, config: &config::ConnectionConfig) -> BackendResult<()>;
    async fn disconnect(&mut self) -> BackendResult<()>;
    fn is_connected(&self) -> bool;
    fn set_log_sink(&mut self, sink: Option<Arc<dyn Fn(LogText, LogKind) + Send + Sync>>);
    /// Writes a translated line into this connection's log panel, for callers
    /// above the protocol layer that have something to tell the user about a
    /// connection they only hold as a `dyn ProtocolBackend`. Defaults to
    /// discarding it, so a backend with no log sink of its own needs no impl.
    fn log_event(&self, _key: &'static str, _params: serde_json::Value, _kind: LogKind) {}

    async fn list(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>>;
    /// Recursive operations must not follow directory links outside their root.
    async fn list_for_recursive(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        self.list(path).await
    }
    async fn mkdir(&mut self, path: &str) -> BackendResult<()>;
    async fn create_file(&mut self, path: &str) -> BackendResult<()>;
    async fn remove(&mut self, path: &str, is_dir: bool) -> BackendResult<()>;
    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()>;
    /// Protocols without an atomic no-replace primitive must fail closed.
    async fn rename_no_replace(&mut self, _old_path: &str, _new_path: &str) -> BackendResult<()> {
        Err(fail(
            crate::ipc::ErrorCode::InvalidInput,
            "This server protocol cannot guarantee no-replace commit; explicit overwrite permission is required",
        ))
    }
    async fn chmod(&mut self, _path: &str, _mode: u32) -> BackendResult<()> {
        anyhow::bail!("Changing permissions is only supported for SFTP connections")
    }
    async fn size(&mut self, path: &str) -> u64;

    /// Preserves the distinction between an unknown length and a real
    /// zero-byte file for transfer integrity checks.
    async fn known_size(&mut self, path: &str) -> Option<u64> {
        Some(self.size(path).await)
    }

    /// Reads at most `len` bytes at `offset`, returning fewer only at EOF.
    ///
    /// A resumed upload appends to bytes an earlier attempt wrote, so it must
    /// prove those bytes still match the local source before extending them.
    /// Protocols that cannot read a range have no way to prove it, and the
    /// default keeps them from resuming at all rather than trusting a length.
    ///
    /// Callers must request a range that ends at end of file. FTP can only
    /// position a read, not bound it, so bounding one there would mean aborting
    /// a transfer mid-stream and risking a desynchronised control channel. Since
    /// the only caller verifies the tail of a staging file, the restriction
    /// costs nothing and keeps every implementation to one safe shape.
    async fn read_range(
        &mut self,
        _path: &str,
        _offset: u64,
        _len: usize,
    ) -> BackendResult<Vec<u8>> {
        Err(fail(
            crate::ipc::ErrorCode::InvalidInput,
            "This protocol cannot read a byte range",
        ))
    }

    async fn upload(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()>;
    async fn download(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()>;

    async fn download_to_writer(
        &mut self,
        remote_path: &str,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> BackendResult<()>;
    async fn upload_from_reader(
        &mut self,
        reader: &mut (dyn AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> BackendResult<()>;
}
