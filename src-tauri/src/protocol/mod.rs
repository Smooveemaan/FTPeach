mod backend_logger;
mod failure;
pub use failure::fail;
pub mod config;
pub mod ftp;
pub mod known_hosts;
mod list_parse;
mod proxy;
pub mod sftp;
pub mod transfer_file;
pub mod transport;
pub mod webdav;

use async_trait::async_trait;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};

/// A credential-bearing value which cannot be accidentally exposed through
/// formatting. Access is deliberately explicit at the protocol boundary.
#[derive(Clone, Default)]
pub struct SensitiveString(String);

impl SensitiveString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SensitiveString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl std::fmt::Display for SensitiveString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

/// Every backend operation reports failure as an `anyhow::Error`, because a
/// driver mostly forwards whatever its protocol crate produced. What the app
/// itself decides — "this was a timeout", "the user cancelled" — is carried
/// as a typed [`crate::ipc::CommandError`] inside that error; build those with
/// [`fail`] so both classification points read the code rather than the text.
pub type BackendResult<T> = anyhow::Result<T>;

pub const MAX_REMOTE_PATH_LEN: usize = 4096;
pub const MAX_REMOTE_FILENAME_LEN: usize = 1024;
tokio::task_local! { pub static ALLOW_OVERWRITE: bool; }

pub fn overwrite_allowed() -> bool {
    ALLOW_OVERWRITE.try_with(|value| *value).unwrap_or(true)
}
pub const MAX_DIRECTORY_ENTRIES: usize = 10_000;
pub const MAX_DIRECTORY_TEXT_BYTES: usize = 8 * 1024 * 1024;

pub fn validate_remote_path(path: &str) -> BackendResult<()> {
    if path.len() > MAX_REMOTE_PATH_LEN {
        anyhow::bail!(crate::ipc::CommandError::new(
            crate::ipc::ErrorCode::ResourceLimit,
            "Remote path exceeds the 4096-byte limit",
        ));
    }
    Ok(())
}

/// A conservative lexical guard; native directory rename remains responsible
/// for server aliases and mount semantics. Never emulate it with copy/delete.
pub fn validate_remote_relationship(source: &str, destination: &str) -> BackendResult<()> {
    fn components(path: &str) -> Vec<String> {
        let mut parts = Vec::new();
        for part in path.split(['/', '\\']) {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part.to_lowercase()),
            }
        }
        parts
    }
    let source = components(source);
    let target = components(destination);
    anyhow::ensure!(
        !target.starts_with(&source),
        "{destination}: Destination is the source or is inside the source folder"
    );
    Ok(())
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
                "Remote directory listing exceeds the 8 MiB text limit",
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
        Value::String(value) => Value::String(crate::runtime::diagnostics::redact(&value)),
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
    fn sensitive_values_and_event_fields_are_never_formatted_verbatim() {
        let secret = SensitiveString::new("known-secret");
        assert_eq!(format!("{secret}"), "[REDACTED]");
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
    fn set_log_enabled(&mut self, enabled: bool);
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
    fn supports_empty_directory_remove(&self) -> bool {
        false
    }
    async fn remove_empty_directory(&mut self, _path: &str) -> BackendResult<()> {
        Err(fail(
            crate::ipc::ErrorCode::InvalidInput,
            "This protocol cannot atomically remove only an empty directory",
        ))
    }
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
