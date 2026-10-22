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
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;
mod connect;
#[cfg(test)]
use self::connect::key_file_error;
mod host_key;
pub use self::host_key::HostKeyMismatchError;
use self::host_key::TofuHandler;
#[cfg(test)]
use self::host_key::encode_hex;
mod pipeline;
use self::pipeline::{read_pipelined, write_pipelined};

const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(20);
const CHUNK_SIZE: usize = 32 * 1024;
const GRACEFUL_IO_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_WINDOW: usize = 16;
const READ_WINDOW: usize = 16;
const TRANSFER_STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// OpenSSH's rename that replaces an existing file, as POSIX rename(2) does.
const POSIX_RENAME: &str = "posix-rename@openssh.com";

/// The body of a `posix-rename@openssh.com` request: both paths as SSH strings.
fn posix_rename_request(old_path: &str, new_path: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + old_path.len() + new_path.len());
    for path in [old_path, new_path] {
        data.extend_from_slice(&(path.len() as u32).to_be_bytes());
        data.extend_from_slice(path.as_bytes());
    }
    data
}

fn already_exists(path: &str) -> anyhow::Error {
    super::fail(
        ErrorCode::AlreadyExists,
        format!("{path} already exists on the server; it was not replaced"),
    )
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
    /// Scheme and host, for the Mark of the Web a download carries. Never
    /// the account: the mark is a file attribute any program can read.
    origin_base: String,
    /// The server offered `posix-rename@openssh.com`, the only rename that
    /// may replace an existing file.
    posix_rename: bool,
}

impl Drop for SftpBackend {
    fn drop(&mut self) {
        if let Some(handle) = self.keep_alive_handle.take() {
            handle.abort();
        }
    }
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
            origin_base: String::new(),
            posix_rename: false,
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

    async fn download_file(
        &self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: &ProgressSink,
    ) -> BackendResult<()> {
        let target = super::transfer_file::DownloadTarget::reserve(local_path).await?;
        let raw = self.sftp()?;
        let attrs = raw
            .stat(remote_path.to_string())
            .await
            .ok()
            .map(|a| a.attrs);
        let remote_size = attrs.as_ref().and_then(|a| a.size);
        let version = attrs
            .as_ref()
            .and_then(|a| a.mtime)
            .map(|mtime| mtime.to_string());
        let source = super::transfer_file::SourceIdentity {
            endpoint: self.endpoint.clone(),
            remote_path: remote_path.to_string(),
            size: remote_size,
            version,
        };
        let origin = crate::local_fs::provenance::Origin::for_url(&self.origin_base, remote_path);
        let Some(download) = target.prepare(resume, source, origin).await? else {
            return Ok(());
        };

        let start_at = download.start();
        let written: BackendResult<u64> = async {
            let mut file = download.open_at(start_at).await?;
            let handle = raw
                .open(
                    remote_path.to_string(),
                    OpenFlags::READ,
                    FileAttributes::empty(),
                )
                .await
                .context("opening remote file")?
                .handle;

            let read_result =
                read_pipelined(&raw, &handle, &mut file, start_at, remote_size, progress).await;
            let closed = raw.close(handle.as_str()).await;
            let offset = read_result?;
            closed.context("closing remote file after download")?;
            file.flush().await.context("flushing local file")?;
            Ok(offset)
        }
        .await;
        download.finish(written, remote_size).await
    }

    /// russh-sftp keeps a request waiting after the SSH connection goes away
    /// and fails it only at its own request timeout, as `Timeout`. A closed
    /// session tells a dropped link from a server that is merely slow.
    async fn lost_if_closed<T>(&self, result: BackendResult<T>) -> BackendResult<T> {
        let Err(error) = result else { return result };
        let timed_out = error.chain().any(|source| {
            matches!(
                source.downcast_ref::<SftpClientError>(),
                Some(SftpClientError::Timeout)
            )
        });
        let closed = timed_out
            && self
                .session
                .lock()
                .await
                .as_ref()
                .is_none_or(|session| session.is_closed());
        if closed {
            return Err(error.context(crate::ipc::CommandError::new(
                ErrorCode::ConnectionLost,
                "The server closed the connection",
            )));
        }
        Err(error)
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
        connected: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(KEEP_ALIVE_INTERVAL);
            interval.tick().await; // first tick is immediate; skip it
            loop {
                interval.tick().await;
                let session = sftp.read().unwrap().clone();
                match session {
                    Some(raw) => {
                        let reply = tokio::time::timeout(GRACEFUL_IO_TIMEOUT, raw.stat(".")).await;
                        // A permission-denied STAT is still a live server reply.
                        if !matches!(reply, Ok(Ok(_)) | Ok(Err(SftpClientError::Status(_)))) {
                            connected.store(false, Ordering::SeqCst);
                            *sftp.write().unwrap() = None;
                            break;
                        }
                    }
                    None => break,
                }
            }
        })
    }

    async fn list_entries(&self, path: &str, recursive: bool) -> BackendResult<Vec<EntryInfo>> {
        let target = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        self.log_kind(format!("READDIR {target}"), LogKind::Command);
        let raw = self.sftp()?;
        if recursive {
            let attrs = raw.lstat(target.clone()).await?.attrs;
            // ProFTPD answers LSTAT for a link with what it leads to; only
            // READLINK gives the link away there.
            anyhow::ensure!(
                !attrs.is_symlink() && raw.readlink(target.clone()).await.is_err(),
                "Recursive operations cannot traverse an SFTP symbolic link: {target}"
            );
        }

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
        let mut text_bytes = 0usize;
        loop {
            match raw.readdir(handle.as_str()).await {
                Ok(name) => {
                    if name.files.is_empty() {
                        let _ = raw.close(handle.as_str()).await;
                        anyhow::bail!("SFTP READDIR returned no entries without EOF");
                    }
                    for file in &name.files {
                        text_bytes = text_bytes
                            .saturating_add(file.filename.len())
                            .saturating_add(file.longname.len());
                    }
                    raw_files.extend(name.files);
                    if raw_files.len() > super::MAX_RAW_DIRECTORY_ENTRIES
                        || text_bytes > super::MAX_DIRECTORY_TEXT_BYTES
                    {
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
                anyhow::ensure!(
                    !recursive,
                    "Recursive operations cannot preserve SFTP symbolic links: {}",
                    file.filename
                );
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

    /// Removes a tree depth-first from an explicit stack, so a deep folder
    /// costs memory for its path list rather than nested futures.
    async fn remove_tree(&mut self, root: &str) -> BackendResult<()> {
        let mut stack = vec![(root.to_string(), 0, false)];
        while let Some((path, depth, emptied)) = stack.pop() {
            if emptied {
                self.sftp()?.rmdir(path).await?;
                continue;
            }
            if !remote_remove_depth_allowed(depth) {
                return Err(anyhow!(
                    "Folder nesting too deep to remove (> {MAX_REMOTE_REMOVE_DEPTH} levels)"
                ));
            }
            let entries = self.list_for_recursive(&path).await?;
            stack.push((path.clone(), depth, true));
            for entry in entries {
                let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
                if entry.is_directory {
                    stack.push((child, depth + 1, false));
                } else {
                    self.sftp()?.remove(child).await?;
                }
            }
        }
        Ok(())
    }
}

#[async_trait]
impl ProtocolBackend for SftpBackend {
    async fn connect(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.open(config).await
    }

    async fn disconnect(&mut self) -> BackendResult<()> {
        if let Some(handle) = self.keep_alive_handle.take() {
            handle.abort();
        }
        self.connected.store(false, Ordering::SeqCst);
        *self.sftp.write().unwrap() = None;
        self.posix_rename = false;
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

    fn set_log_sink(&mut self, sink: Option<LogSink>) {
        self.logger.set_sink(sink);
    }

    fn log_event(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.log_key(key, params, kind);
    }

    async fn list(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        let result = self.list_entries(path, false).await;
        self.lost_if_closed(result).await
    }

    async fn list_for_recursive(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        let result = self.list_entries(path, true).await;
        self.lost_if_closed(result).await
    }
    async fn mkdir(&mut self, path: &str) -> BackendResult<()> {
        let raw = self.sftp()?;
        raw.mkdir(path.to_string(), FileAttributes::empty()).await?;
        Ok(())
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        let raw = self.sftp()?;
        let opened = raw
            .open(
                path.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes::empty(),
            )
            .await;
        let handle = match opened {
            Ok(handle) => handle.handle,
            // v3 has no "file exists" status: EXCLUDE on a taken name is a plain failure.
            Err(SftpClientError::Status(status))
                if status.status_code == StatusCode::Failure
                    && raw.lstat(path.to_string()).await.is_ok() =>
            {
                return Err(already_exists(path));
            }
            Err(error) => return Err(error.into()),
        };
        raw.close(handle).await?;
        Ok(())
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> BackendResult<()> {
        if is_dir {
            self.remove_tree(path).await
        } else {
            self.sftp()?.remove(path.to_string()).await?;
            Ok(())
        }
    }

    /// Replaces whatever stands at `new_path`. SSH_FXP_RENAME (v3) leaves an
    /// existing target unspecified and OpenSSH refuses it, so a server that
    /// offers posix-rename gets that. Any other still tries the plain rename,
    /// which some servers let replace, and when it is refused with both files
    /// still there, the existing one is set aside rather than deleted.
    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let raw = self.sftp()?;
        if self.posix_rename {
            return match raw
                .extended(POSIX_RENAME, posix_rename_request(old_path, new_path))
                .await?
            {
                Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
                Packet::Status(status) => Err(SftpClientError::Status(status).into()),
                _ => Err(anyhow!("Unexpected reply to {POSIX_RENAME}")),
            };
        }
        let Err(error) = raw.rename(old_path.to_string(), new_path.to_string()).await else {
            return Ok(());
        };
        let refused = matches!(
            &error,
            SftpClientError::Status(status) if status.status_code == StatusCode::Failure
        );
        // Only a file is set aside; a folder in the way stays an error.
        if refused
            && raw
                .stat(new_path.to_string())
                .await
                .is_ok_and(|target| !target.attrs.is_dir())
            && raw.stat(old_path.to_string()).await.is_ok()
        {
            return super::replace_by_setting_aside(self, old_path, new_path).await;
        }
        Err(error.into())
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
        // Not every server keeps to that (SFTPGo replaces the target), so an
        // existing target is refused before the rename is sent.
        let raw = self.sftp()?;
        if raw.lstat(new_path.to_string()).await.is_ok() {
            return Err(already_exists(new_path));
        }
        let Err(error) = raw.rename(old_path.to_string(), new_path.to_string()).await else {
            return Ok(());
        };
        let refused = matches!(
            &error,
            SftpClientError::Status(status) if status.status_code == StatusCode::Failure
        );
        if refused && raw.stat(new_path.to_string()).await.is_ok() {
            return Err(already_exists(new_path));
        }
        Err(error.into())
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
                    .read(
                        handle.as_str(),
                        offset
                            .checked_add(buf.len() as u64)
                            .context("SFTP range offset overflow")?,
                        want,
                    )
                    .await
                {
                    // A short read is not EOF; only an empty one ends the range.
                    Ok(data) if data.data.is_empty() => break,
                    Ok(data) => {
                        anyhow::ensure!(
                            data.data.len() <= want as usize,
                            "SFTP server exceeded requested read length"
                        );
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
        self.lost_if_closed(read).await
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
            self.known_size(remote_path).await.unwrap_or(0)
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
                OpenFlags::WRITE
            } else {
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
            };
            let handle = raw
                .open(remote_path.to_string(), flags, FileAttributes::empty())
                .await
                .context("opening remote file")?
                .handle;

            let write_result =
                write_pipelined(&raw, &handle, &mut file, remote_size, local_size, &progress).await;
            let closed = raw.close(handle.as_str()).await;
            let written = write_result?;
            closed.context("closing remote file after upload")?;
            super::transfer_file::validate_length(written, Some(local_size))?;
            Ok(())
        }
        .await;

        let result = self.lost_if_closed(result).await;
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
        super::transfer_file::report_outcome(&result, &progress);
        result
    }

    async fn download(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()> {
        let result = self
            .download_file(remote_path, local_path, resume, &progress)
            .await;
        let result = self.lost_if_closed(result).await;
        super::transfer_file::report_outcome(&result, &progress);
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

        let progress: ProgressSink = Arc::new(|_| {});
        let result = read_pipelined(&raw, &handle, writer, 0, None, &progress).await;
        let closed = raw.close(handle.as_str()).await;
        self.lost_if_closed(result).await?;
        closed.context("closing remote file")?;
        Ok(())
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

        let progress: ProgressSink = Arc::new(|_| {});
        let result = write_pipelined(&raw, &handle, reader, 0, 0, &progress).await;
        let closed = raw.close(handle.as_str()).await;
        self.lost_if_closed(result).await?;
        closed.context("closing remote file after upload")?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "sftp_tests.rs"]
mod protocol_tests;
