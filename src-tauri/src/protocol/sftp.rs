use super::backend_logger::{BackendLogger, LogSink};
use super::{
    BackendResult, EntryInfo, LogKind, LogText, ProgressInfo, ProgressSink, ProtocolBackend,
};
use crate::ipc::ErrorCode;
use crate::protocol::known_hosts::{HostKeyPinOutcome, KnownHostsStore};
use crate::security::connection_guard::{
    MAX_REMOTE_REMOVE_DEPTH, is_safe_path_segment, remote_remove_depth_allowed,
};
use anyhow::{Context, anyhow};
use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key};
use russh_sftp::client::error::Error as SftpClientError;
use russh_sftp::client::rawsession::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(20);
const CHUNK_SIZE: usize = 32 * 1024;
const GRACEFUL_IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct HostKeyMismatchError {
    pub host: String,
    pub port: u16,
    pub expected: String,
    pub actual: String,
}

impl std::fmt::Display for HostKeyMismatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "The server key for {}:{} has changed since the last connection (expected SHA256 \
             fingerprint {}, got {}). This may indicate a spoofed server (a man-in-the-middle \
             attack) or that the server was reinstalled. Connection stopped.",
            self.host, self.port, self.expected, self.actual
        )
    }
}

impl std::error::Error for HostKeyMismatchError {}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

struct TofuHandler {
    known_hosts: Arc<dyn KnownHostsStore>,
    host: String,
    port: u16,
    mismatch: Arc<StdMutex<Option<HostKeyMismatchError>>>,
}

impl client::Handler for TofuHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let raw = server_public_key
            .public_key()
            .to_bytes()
            .context("encoding host public key")?;
        let fingerprint = encode_hex(&Sha256::digest(&raw));

        match self
            .known_hosts
            .pin_or_verify(&self.host, self.port, &fingerprint)
            .await
            .context("pinning host key to known_hosts.json")?
        {
            HostKeyPinOutcome::Pinned | HostKeyPinOutcome::Matched => Ok(true),
            HostKeyPinOutcome::Mismatched { expected } => {
                *self.mismatch.lock().unwrap() = Some(HostKeyMismatchError {
                    host: self.host.clone(),
                    port: self.port,
                    expected,
                    actual: fingerprint,
                });
                Ok(false)
            }
        }
    }
}

fn parse_longname(longname: &str) -> (Option<String>, Option<String>, Option<String>) {
    let parts: Vec<&str> = longname.split_whitespace().collect();
    if parts.len() < 4 {
        return (None, None, None);
    }
    let permissions = parts[0].get(1..).map(|s| s.to_string());
    (
        permissions,
        Some(parts[2].to_string()),
        Some(parts[3].to_string()),
    )
}

pub struct SftpBackend {
    known_hosts: Arc<dyn KnownHostsStore>,
    session: Arc<AsyncMutex<Option<client::Handle<TofuHandler>>>>,
    sftp: Arc<StdRwLock<Option<Arc<RawSftpSession>>>>,
    connected: Arc<AtomicBool>,
    keep_alive_handle: Option<tokio::task::JoinHandle<()>>,
    logger: BackendLogger,
    endpoint: String,
}

impl SftpBackend {
    /// Takes only the host-key pinning it actually performs, not a whole
    /// `Store`: the backend has no other reason to know persistence exists.
    pub fn new(known_hosts: Arc<dyn KnownHostsStore>) -> Self {
        Self {
            known_hosts,
            session: Arc::new(AsyncMutex::new(None)),
            sftp: Arc::new(StdRwLock::new(None)),
            connected: Arc::new(AtomicBool::new(false)),
            keep_alive_handle: None,
            logger: BackendLogger::default(),
            endpoint: String::new(),
        }
    }

    fn log_kind(&self, line: impl Into<LogText>, kind: LogKind) {
        self.logger.emit(line, kind);
    }

    // See ftp.rs's identical helper's doc comment — human-authored,
    // translated log line vs. `log`/`log_kind`'s untranslated raw text.
    fn log_key(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.logger.event(key, params, kind);
    }

    fn sftp(&self) -> BackendResult<Arc<RawSftpSession>> {
        self.sftp.read().unwrap().clone().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })
    }

    fn spawn_keep_alive(
        sftp: Arc<StdRwLock<Option<Arc<RawSftpSession>>>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(KEEP_ALIVE_INTERVAL);
            interval.tick().await; // first tick is immediate; skip it
            loop {
                interval.tick().await;
                let session = sftp.read().unwrap().clone();
                match session {
                    Some(raw) => {
                        let _ = tokio::time::timeout(GRACEFUL_IO_TIMEOUT, raw.stat(".")).await;
                    }
                    None => break,
                }
            }
        })
    }

    fn remove_with_depth<'a>(
        &'a mut self,
        path: &'a str,
        is_dir: bool,
        depth: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = BackendResult<()>> + Send + 'a>> {
        Box::pin(async move {
            if !remote_remove_depth_allowed(depth) {
                return Err(anyhow!(
                    "Folder nesting too deep to remove (> {MAX_REMOTE_REMOVE_DEPTH} levels)"
                ));
            }
            if !is_dir {
                let raw = self.sftp()?;
                raw.remove(path.to_string()).await?;
                return Ok(());
            }
            let entries = self.list(path).await?;
            for entry in entries {
                let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
                self.remove_with_depth(&child, entry.is_directory, depth + 1)
                    .await?;
            }
            let raw = self.sftp()?;
            raw.rmdir(path.to_string()).await?;
            Ok(())
        })
    }
}

#[async_trait]
impl ProtocolBackend for SftpBackend {
    async fn connect(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.disconnect().await.ok();
        let crate::protocol::config::ConnectionConfig::Sftp(config) = config else {
            return Err(anyhow!("SFTP backend received a non-SFTP configuration"));
        };
        self.endpoint =
            serde_json::json!(["sftp", config.host.to_lowercase(), config.port, config.user])
                .to_string();
        let host = config.host.clone();
        let port = config.port;
        let user = config.user.clone();
        let password = config.password.clone();
        let use_key_auth = config.use_key_auth;
        let key_path = config.key_path.clone();
        let key_passphrase = config.key_passphrase.clone();
        let timeout_ms = config.common.timeout_ms;
        let proxy = config.common.proxy.clone();

        self.log_key(
            "connecting",
            serde_json::json!({ "addr": format!("{host}:{port}") }),
            LogKind::Status,
        );

        let mismatch: Arc<StdMutex<Option<HostKeyMismatchError>>> = Arc::new(StdMutex::new(None));
        let handler = TofuHandler {
            known_hosts: self.known_hosts.clone(),
            host: host.clone(),
            port,
            mismatch: mismatch.clone(),
        };

        let connect_fut = async {
            let ssh_config = Arc::new(client::Config::default());
            let tcp = crate::protocol::transport::connect(&host, port, proxy.as_ref())
                .await
                .context("proxy/TCP connect failed")?;
            let mut session = client::connect_stream(ssh_config, tcp, handler)
                .await
                .context("SSH handshake failed")?;

            if use_key_auth {
                let key_path = key_path
                    .ok_or_else(|| super::fail(ErrorCode::InvalidInput, "No key file specified"))?;
                let key = load_secret_key(&key_path, key_passphrase.as_deref())
                    .with_context(|| format!("failed to read key file \"{key_path}\""))?;
                let auth = session
                    .authenticate_publickey(
                        user.as_str(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .context("key auth failed")?;
                if !auth.success() {
                    return Err(super::fail(
                        ErrorCode::AuthFailed,
                        "The server rejected key authentication",
                    ));
                }
            } else {
                let auth = session
                    .authenticate_password(user.as_str(), password.as_str())
                    .await
                    .context("password auth failed")?;
                if !auth.success() {
                    return Err(super::fail(
                        ErrorCode::AuthFailed,
                        "Invalid username or password",
                    ));
                }
            }

            let channel = session
                .channel_open_session()
                .await
                .context("opening channel failed")?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .context("requesting sftp subsystem failed")?;
            let raw = RawSftpSession::new(channel.into_stream());
            raw.init().await.context("sftp init failed")?;

            Ok::<_, anyhow::Error>((session, raw))
        };

        let outcome = if timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), connect_fut).await {
                Ok(inner) => inner,
                Err(_) => Err(super::fail(
                    ErrorCode::TimedOut,
                    "Connection attempt timed out",
                )),
            }
        } else {
            connect_fut.await
        };

        let (session, raw) = match outcome {
            Ok(pair) => pair,
            Err(err) => {
                if let Some(m) = mismatch.lock().unwrap().take() {
                    self.log_key(
                        "connectFailed",
                        serde_json::json!({ "error": format!("{m}") }),
                        LogKind::Error,
                    );
                    return Err(m.into());
                }
                self.log_key(
                    "connectFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err);
            }
        };

        self.log_key("connected", serde_json::json!({}), LogKind::Response);
        *self.session.lock().await = Some(session);
        *self.sftp.write().unwrap() = Some(Arc::new(raw));
        self.connected.store(true, Ordering::SeqCst);
        self.keep_alive_handle = Some(Self::spawn_keep_alive(self.sftp.clone()));
        Ok(())
    }

    async fn disconnect(&mut self) -> BackendResult<()> {
        if let Some(handle) = self.keep_alive_handle.take() {
            handle.abort();
        }
        self.connected.store(false, Ordering::SeqCst);
        *self.sftp.write().unwrap() = None;
        if let Some(session) = self.session.lock().await.take() {
            let _ = tokio::time::timeout(
                GRACEFUL_IO_TIMEOUT,
                session.disconnect(russh::Disconnect::ByApplication, "", "en"),
            )
            .await;
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn set_log_enabled(&mut self, enabled: bool) {
        self.logger.set_enabled(enabled);
    }

    fn set_log_sink(&mut self, sink: Option<LogSink>) {
        self.logger.set_sink(sink);
    }

    fn log_event(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.log_key(key, params, kind);
    }

    async fn list(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        let target = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        self.log_kind(format!("READDIR {target}"), LogKind::Command);
        let raw = self.sftp()?;

        let handle = match raw.opendir(target.clone()).await {
            Ok(dir) => dir.handle,
            Err(err) => {
                self.log_key(
                    "listFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err).context("opendir failed");
            }
        };
        let mut raw_files = Vec::new();
        loop {
            match raw.readdir(handle.as_str()).await {
                Ok(name) => {
                    raw_files.extend(name.files);
                    if raw_files.len() > super::MAX_DIRECTORY_ENTRIES {
                        let _ = raw.close(handle.as_str()).await;
                        anyhow::bail!(crate::ipc::CommandError::new(
                            crate::ipc::ErrorCode::ResourceLimit,
                            "Remote directory contains too many entries",
                        ));
                    }
                }
                Err(SftpClientError::Status(status)) if status.status_code == StatusCode::Eof => {
                    break;
                }
                Err(err) => {
                    let _ = raw.close(handle.as_str()).await;
                    self.log_key(
                        "listFailed",
                        serde_json::json!({ "error": format!("{err:#}") }),
                        LogKind::Error,
                    );
                    return Err(err.into());
                }
            }
        }
        let _ = raw.close(handle.as_str()).await;

        let mut entries = Vec::with_capacity(raw_files.len());
        for file in raw_files {
            if file.filename == "." || file.filename == ".." {
                continue;
            }
            if !is_safe_path_segment(&file.filename) {
                self.log_key(
                    "skippedUnsafeEntry",
                    serde_json::json!({ "name": file.filename }),
                    LogKind::Status,
                );
                continue;
            }
            let (permissions, owner, group) = parse_longname(&file.longname);

            let mut is_directory = file.attrs.is_dir();
            if file.attrs.is_symlink() {
                let child = format!("{}/{}", target.trim_end_matches('/'), file.filename);
                if let Ok(target_attrs) = raw.stat(child).await {
                    is_directory = target_attrs.attrs.is_dir();
                }
            }

            entries.push(EntryInfo {
                name: file.filename,
                is_directory,
                size: file.attrs.size.unwrap_or(0),
                modified_at: file
                    .attrs
                    .mtime
                    .and_then(|t| Utc.timestamp_opt(t as i64, 0).single())
                    .map(|d| d.to_rfc3339()),
                permissions,
                owner,
                group,
            });
        }
        self.log_key(
            "receivedEntries",
            serde_json::json!({ "count": entries.len() }),
            LogKind::Response,
        );
        Ok(entries)
    }

    async fn mkdir(&mut self, path: &str) -> BackendResult<()> {
        let raw = self.sftp()?;
        raw.mkdir(path.to_string(), FileAttributes::empty()).await?;
        Ok(())
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        let raw = self.sftp()?;
        let handle = raw
            .open(
                path.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes::empty(),
            )
            .await?
            .handle;
        raw.close(handle).await?;
        Ok(())
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> BackendResult<()> {
        self.remove_with_depth(path, is_dir, 0).await
    }
    fn supports_empty_directory_remove(&self) -> bool {
        true
    }
    async fn remove_empty_directory(&mut self, path: &str) -> BackendResult<()> {
        self.sftp()?.rmdir(path.to_string()).await?;
        Ok(())
    }

    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let raw = self.sftp()?;
        raw.rename(old_path.to_string(), new_path.to_string())
            .await?;
        Ok(())
    }

    async fn chmod(&mut self, path: &str, mode: u32) -> BackendResult<()> {
        anyhow::ensure!(mode <= 0o7777, "Invalid permission mode");
        let raw = self.sftp()?;
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode);
        raw.setstat(path.to_string(), attrs).await?;
        Ok(())
    }

    async fn rename_no_replace(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        // SSH_FXP_RENAME (v3), without the posix-rename extension, fails when
        // newpath exists. Do not substitute the overwriting POSIX extension.
        self.rename(old_path, new_path).await
    }

    async fn size(&mut self, path: &str) -> u64 {
        self.known_size(path).await.unwrap_or(0)
    }

    async fn known_size(&mut self, path: &str) -> Option<u64> {
        let Ok(raw) = self.sftp() else { return None };
        raw.stat(path.to_string())
            .await
            .ok()
            .and_then(|a| a.attrs.size)
    }

    async fn read_range(&mut self, path: &str, offset: u64, len: usize) -> BackendResult<Vec<u8>> {
        let raw = self.sftp()?;
        let handle = raw
            .open(path.to_string(), OpenFlags::READ, FileAttributes::empty())
            .await
            .context("opening remote file")?
            .handle;
        let read = async {
            let mut buf: Vec<u8> = Vec::with_capacity(len.min(CHUNK_SIZE));
            while buf.len() < len {
                let want = (len - buf.len()).min(CHUNK_SIZE) as u32;
                match raw
                    .read(handle.as_str(), offset + buf.len() as u64, want)
                    .await
                {
                    // A short read is not EOF; only an empty one ends the range.
                    Ok(data) if data.data.is_empty() => break,
                    Ok(data) => {
                        buf.extend_from_slice(&data.data);
                        // Verification bytes cross the wire like any others, so
                        // they are paced by the same bandwidth limit.
                        crate::transfer::rate_limiter::shared()
                            .acquire(data.data.len() as u64)
                            .await;
                    }
                    Err(SftpClientError::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        break;
                    }
                    Err(err) => return Err(err).context("reading from server"),
                }
            }
            Ok(buf)
        }
        .await;
        let _ = raw.close(handle.as_str()).await;
        read
    }

    async fn upload(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()> {
        let raw = match self.sftp() {
            Ok(raw) => raw,
            Err(err) => {
                progress(ProgressInfo::failed(&err));
                return Err(err);
            }
        };
        let local_size = tokio::fs::metadata(local_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let remote_size = if resume {
            self.size(remote_path).await
        } else {
            0
        };
        if remote_size > local_size {
            return Err(super::fail(
                ErrorCode::IntegrityMismatch,
                "The remote partial file is larger than the local source",
            ));
        }

        let result: BackendResult<()> = async {
            let mut file = tokio::fs::File::open(local_path)
                .await
                .context("opening local file")?;
            if resume && remote_size > 0 {
                file.seek(std::io::SeekFrom::Start(remote_size))
                    .await
                    .context("seeking local file")?;
            }
            let flags = if resume && remote_size > 0 {
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND
            } else {
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
            };
            let handle = raw
                .open(remote_path.to_string(), flags, FileAttributes::empty())
                .await
                .context("opening remote file")?
                .handle;

            let mut buf = vec![0u8; CHUNK_SIZE];
            let mut transferred = remote_size;
            let write_result: BackendResult<()> = async {
                loop {
                    let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                    let n = file
                        .read(&mut buf[..read_len])
                        .await
                        .context("reading local file")?;
                    if n == 0 {
                        break;
                    }
                    raw.write(handle.as_str(), transferred, buf[..n].to_vec())
                        .await
                        .context("writing to server")?;
                    transferred += n as u64;
                    crate::transfer::rate_limiter::shared()
                        .acquire(n as u64)
                        .await;
                    progress(ProgressInfo::Progress {
                        bytes: transferred,
                        total: local_size,
                    });
                }
                Ok(())
            }
            .await;
            let _ = raw.close(handle.as_str()).await;
            write_result
        }
        .await;

        let result = match result {
            Ok(()) => {
                let actual = self.known_size(remote_path).await;
                super::transfer_file::validate_length(
                    actual.unwrap_or(local_size),
                    Some(local_size),
                )
            }
            Err(err) => Err(err),
        };
        match &result {
            Ok(()) => progress(ProgressInfo::Done),
            Err(err) => progress(ProgressInfo::failed(err)),
        }
        result
    }

    async fn download(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()> {
        let _lease = crate::local_fs::target_reservation::Reservation::acquire(
            &local_path.to_string_lossy(),
        )?;
        let _mutation = crate::local_fs::mutations::guard().lock().await;
        crate::local_fs::mutations::validate_download_name(local_path)?;
        crate::local_fs::filesystem_safety::validate_write_destination(local_path).await?;
        let raw = match self.sftp() {
            Ok(raw) => raw,
            Err(err) => {
                progress(ProgressInfo::failed(&err));
                return Err(err);
            }
        };
        let remote_size = self.known_size(remote_path).await;
        let version = raw
            .stat(remote_path.to_string())
            .await
            .ok()
            .and_then(|a| a.attrs.mtime)
            .map(|mtime| mtime.to_string());
        let source = super::transfer_file::SourceIdentity {
            endpoint: self.endpoint.clone(),
            remote_path: remote_path.to_string(),
            size: remote_size,
            version,
        };
        let (partial_path, start_at) =
            super::transfer_file::prepare(local_path, resume, source).await?;
        super::transfer_file::validate_resume_offset(start_at, remote_size)?;
        if super::transfer_file::commit_if_complete(
            &partial_path,
            local_path,
            start_at,
            remote_size,
        )
        .await?
        {
            progress(ProgressInfo::Done);
            return Ok(());
        }

        let result: BackendResult<()> = async {
            let mut file = tokio::fs::File::from_std(super::transfer_file::open_artifact(
                &partial_path,
                false,
            )?);

            if start_at > 0 {
                file.seek(std::io::SeekFrom::Start(start_at))
                    .await
                    .context("seeking local file")?;
            }
            let handle = raw
                .open(
                    remote_path.to_string(),
                    OpenFlags::READ,
                    FileAttributes::empty(),
                )
                .await
                .context("opening remote file")?
                .handle;

            let mut offset = start_at;
            let read_result: BackendResult<()> = async {
                loop {
                    let read_len =
                        crate::transfer::rate_limiter::paced_chunk_size(CHUNK_SIZE) as u32;
                    match raw.read(handle.as_str(), offset, read_len).await {
                        Ok(data) => {
                            if data.data.is_empty() {
                                break;
                            }
                            file.write_all(&data.data)
                                .await
                                .context("writing local file")?;
                            crate::transfer::rate_limiter::shared()
                                .acquire(data.data.len() as u64)
                                .await;
                            offset += data.data.len() as u64;
                            progress(ProgressInfo::Progress {
                                bytes: offset,
                                total: remote_size.unwrap_or(0),
                            });
                        }
                        Err(SftpClientError::Status(status))
                            if status.status_code == StatusCode::Eof =>
                        {
                            break;
                        }
                        Err(err) => return Err(err).context("reading from server"),
                    }
                }
                Ok(())
            }
            .await;
            let _ = raw.close(handle.as_str()).await;
            read_result?;
            file.flush().await.context("flushing local file")?;
            super::transfer_file::validate_length(offset, remote_size)?;
            drop(file);
            super::transfer_file::commit(&partial_path, local_path).await?;
            Ok(())
        }
        .await;

        match &result {
            Ok(()) => progress(ProgressInfo::Done),
            Err(err) => {
                progress(ProgressInfo::failed(err));
                super::transfer_file::remove_empty_new_partial(&partial_path, start_at).await;
            }
        }
        result
    }

    async fn download_to_writer(
        &mut self,
        remote_path: &str,
        writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> BackendResult<()> {
        let raw = self.sftp()?;
        let handle = raw
            .open(
                remote_path.to_string(),
                OpenFlags::READ,
                FileAttributes::empty(),
            )
            .await
            .context("opening remote file")?
            .handle;

        let result: BackendResult<()> = async {
            let mut offset: u64 = 0;
            loop {
                // Paced like every other transfer loop (see `download`): with
                // a fixed CHUNK_SIZE a slow rate limit made this read 32 KB in
                // one go and then sit inside acquire() for ~32s at 1 KB/s, so
                // whatever consumes the writer — a relay copy, or a drag-out's
                // progress bar — advanced in silent 32 KB jumps.
                let read_len = crate::transfer::rate_limiter::paced_chunk_size(CHUNK_SIZE) as u32;
                match raw.read(handle.as_str(), offset, read_len).await {
                    Ok(data) => {
                        if data.data.is_empty() {
                            break;
                        }
                        writer
                            .write_all(&data.data)
                            .await
                            .context("relaying to target")?;
                        crate::transfer::rate_limiter::shared()
                            .acquire(data.data.len() as u64)
                            .await;
                        offset += data.data.len() as u64;
                    }
                    Err(SftpClientError::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        break;
                    }
                    Err(err) => return Err(err).context("reading from server"),
                }
            }
            Ok(())
        }
        .await;
        let _ = raw.close(handle.as_str()).await;
        result
    }

    async fn upload_from_reader(
        &mut self,
        reader: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> BackendResult<()> {
        let raw = self.sftp()?;
        let handle = raw
            .open(
                remote_path.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                FileAttributes::empty(),
            )
            .await
            .context("opening remote file")?
            .handle;

        let result: BackendResult<()> = async {
            let mut buf = vec![0u8; CHUNK_SIZE];
            let mut offset: u64 = 0;
            loop {
                let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                let n = reader
                    .read(&mut buf[..read_len])
                    .await
                    .context("reading from source")?;
                if n == 0 {
                    break;
                }
                raw.write(handle.as_str(), offset, buf[..n].to_vec())
                    .await
                    .context("writing to server")?;
                // Relay's write side — see download_to_writer's identical
                // comment on why this needs its own acquire() call.
                crate::transfer::rate_limiter::shared()
                    .acquire(n as u64)
                    .await;
                offset += n as u64;
            }
            Ok(())
        }
        .await;
        let _ = raw.close(handle.as_str()).await;
        result
    }
}

#[cfg(test)]
#[path = "sftp_tests.rs"]
mod protocol_tests;
