use super::backend_logger::{BackendLogger, LogSink};
use super::list_parse;
use super::{
    BackendResult, EntryInfo, LogKind, LogText, ProgressInfo, ProgressSink, ProtocolBackend,
};
use crate::ipc::ErrorCode;
use crate::security::connection_guard::{
    MAX_REMOTE_REMOVE_DEPTH, is_safe_path_segment, remote_remove_depth_allowed,
};
use anyhow::{Context, Result as AnyhowResult, anyhow};
use async_trait::async_trait;
use chrono::Utc;
use rustls::ClientConfig;
use rustls_pki_types::ServerName;
use rustls_pki_types::pem::PemObject;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use suppaftp::Status;
use suppaftp::tokio::{
    AsyncDataStream, AsyncRustlsConnector, AsyncRustlsFtpStream, AsyncRustlsStream, TransferStream,
};
use suppaftp::types::FileType as FtpFileType;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;
mod connect;
mod data;
use self::data::{
    DataChannel, RETRIEVE_OPEN, STORE_OPEN, TRANSFER_SETTLED, UploadData, read_list_data,
};
#[cfg(test)]
use self::data::{epsv_port, pasv_port};
mod tls;
use self::tls::{NoCertVerification, SessionTickets, answers_tls};
mod listing;
mod paths;

const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(20);
const COPY_CHUNK_SIZE: usize = 64 * 1024;
const DATA_IDLE_TIMEOUT: Duration = Duration::from_secs(3);
const GRACEFUL_IO_TIMEOUT: Duration = Duration::from_secs(5);
const TRANSFER_STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Links in one listing whose kind is looked up, one CWD each.
const MAX_RESOLVED_LINKS: usize = 64;
/// How long a silent server may keep its greeting before it is asked whether
/// it waits for TLS instead: an implicit FTPS server greets only after it.
const IMPLICIT_PROBE_AFTER: Duration = Duration::from_secs(2);
/// How long that TLS probe may take.
const IMPLICIT_PROBE_WAIT: Duration = Duration::from_secs(5);
/// How long an upload waits for the TLS 1.3 ticket its data connection brings.
const TICKET_WAIT: Duration = Duration::from_millis(500);
/// How long a data connection waits for the reply before starting TLS anyway.
const HANDSHAKE_FIRST_WAIT: Duration = Duration::from_millis(500);
/// Folders a recursive walk has seen listed as folders, not links, kept so it
/// can enter them without checking again.
const MAX_REAL_FOLDERS: usize = 100_000;

struct BusyGuard(Arc<AtomicUsize>);

/// An interrupted command can leave replies queued on the control socket.
/// Keep it out of the pool unless the entire operation completed safely.
struct StreamOperation<'a> {
    slot: tokio::sync::MutexGuard<'a, Option<AsyncRustlsFtpStream>>,
    connected: &'a AtomicBool,
    reusable: bool,
}

impl Drop for StreamOperation<'_> {
    fn drop(&mut self) {
        if !self.reusable {
            *self.slot = None;
            self.connected.store(false, Ordering::SeqCst);
        }
    }
}
impl BusyGuard {
    fn enter(busy: &Arc<AtomicUsize>) -> Self {
        busy.fetch_add(1, Ordering::SeqCst);
        Self(busy.clone())
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Whether FEAT announced RFC 3659 machine listings. A server lists MLST
/// there for the pair; MLSD comes with it.
fn feat_offers_mlsd(feat: &str) -> bool {
    feat.lines().any(|line| {
        let feature = line.split_whitespace().next().unwrap_or_default();
        feature.eq_ignore_ascii_case("MLST") || feature.eq_ignore_ascii_case("MLSD")
    })
}

/// The server turned PORT or EPRT away, or could not connect back: pure-ftpd
/// "500 I won't open a connection to", vsftpd "500 Illegal PORT command", or a
/// 425. An unknown listing command, "500 Unknown command", is not one.
fn active_mode_refused(response: &suppaftp::types::Response) -> bool {
    let text = String::from_utf8_lossy(&response.body).to_ascii_lowercase();
    match response.status.code() {
        425 => true,
        500 | 501 => text.contains("port") || text.contains("connection"),
        _ => false,
    }
}

/// Whether the server turned a command away as one it does not implement,
/// rather than failing it over what it was asked to do.
fn command_refused(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<suppaftp::FtpError>(),
            Some(suppaftp::FtpError::UnexpectedResponse(response))
                if unsupported_reply(response.status)
        )
    })
}

/// The replies a server gives a command it does not implement.
fn unsupported_reply(status: Status) -> bool {
    matches!(
        status,
        Status::BadCommand
            | Status::BadArguments
            | Status::NotImplemented
            | Status::NotImplementedParameter
    )
}

/// A greeting other than 220 turns the session away before any login (SFTPGo
/// answers `500 Access denied` past its connections per address). Replies the
/// general classification already names, such as 421 "too many", keep theirs.
fn refused_greeting(error: anyhow::Error) -> anyhow::Error {
    let replied = error.chain().any(|source| {
        matches!(
            source.downcast_ref::<suppaftp::FtpError>(),
            Some(suppaftp::FtpError::UnexpectedResponse(_))
        )
    });
    if replied && crate::ipc::CommandError::unexplained(&error) {
        return error.context(crate::ipc::CommandError::new(
            ErrorCode::ConnectionRefused,
            "The server refused the connection",
        ));
    }
    error
}

/// Why an upload's data connection broke. A server that runs out of room
/// closes it, and gives the reason (552) on the control connection.
async fn upload_refusal(
    control: &mut AsyncRustlsFtpStream,
    mut data: UploadData,
    error: anyhow::Error,
) -> anyhow::Error {
    // Reset, as dropping the upload would, before the reply is read.
    let verdict = async {
        match data.0.take() {
            Some(stream) => {
                let _ = stream.socket().set_zero_linger();
                stream.settle(control).await
            }
            None => control.read_response_in(TRANSFER_SETTLED).await.map(drop),
        }
    };
    match tokio::time::timeout(GRACEFUL_IO_TIMEOUT, verdict).await {
        Ok(Err(reply @ suppaftp::FtpError::UnexpectedResponse(_))) => {
            anyhow::Error::from(reply).context(format!("{error:#}"))
        }
        _ => error,
    }
}

/// The answer to a command a server may not support (SIZE, MDTM): a refusal
/// is no answer, while a 421 or a broken connection stays an error.
fn optional_reply<T>(reply: Result<T, suppaftp::FtpError>) -> BackendResult<Option<T>> {
    match reply {
        Ok(value) => Ok(Some(value)),
        Err(suppaftp::FtpError::UnexpectedResponse(response))
            if response.status != Status::NotAvailable =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// Whether the error ends in the server's own refusal: a complete negative
/// reply, after which the control connection is ready for the next command.
/// A 421 is the server closing the connection, so it does not count.
fn refused_by_server(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<suppaftp::FtpError>(),
            Some(suppaftp::FtpError::UnexpectedResponse(response))
                if response.status.code() >= 400 && response.status != Status::NotAvailable
        )
    })
}

pub struct FtpBackend {
    stream: Arc<AsyncMutex<Option<AsyncRustlsFtpStream>>>,
    data: Option<DataChannel>,
    real_folders: std::collections::HashSet<String>,
    connected: Arc<AtomicBool>,
    /// Listings come by MLSD, which names every entry, rather than by LIST,
    /// which many servers print without the names that start with a dot.
    mlsd: bool,
    busy: Arc<AtomicUsize>,
    keep_alive_handle: Option<tokio::task::JoinHandle<()>>,
    logger: BackendLogger,
    endpoint: String,
    /// Scheme and host, for the Mark of the Web a download carries. Never
    /// the account: the mark is a file attribute any program can read.
    origin_base: String,
}

impl Drop for FtpBackend {
    fn drop(&mut self) {
        if let Some(handle) = self.keep_alive_handle.take() {
            handle.abort();
        }
    }
}

impl Default for FtpBackend {
    fn default() -> Self {
        Self {
            stream: Arc::new(AsyncMutex::new(None)),
            connected: Arc::new(AtomicBool::new(false)),
            mlsd: false,
            data: None,
            real_folders: std::collections::HashSet::new(),
            busy: Arc::new(AtomicUsize::new(0)),
            keep_alive_handle: None,
            logger: BackendLogger::default(),
            endpoint: String::new(),
            origin_base: String::new(),
        }
    }
}

impl FtpBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn log_response_body(&self, body: &[u8]) {
        let text = String::from_utf8_lossy(body);
        for line in text
            .split(['\r', '\n'])
            .map(str::trim)
            .filter(|l| !l.is_empty())
        {
            self.logger.emit(line.to_string(), LogKind::Response);
        }
    }

    async fn logged_command(
        &self,
        stream: &mut AsyncRustlsFtpStream,
        cmd: String,
        display: impl Into<LogText>,
        expected: &[Status],
    ) -> BackendResult<suppaftp::types::Response> {
        self.logger.emit(display, LogKind::Command);
        match stream.custom_command(cmd, expected).await {
            Ok(resp) => {
                self.log_response_body(&resp.body);
                Ok(resp)
            }
            Err(err) => {
                self.logger.emit(format!("{err}"), LogKind::Error);
                Err(err.into())
            }
        }
    }

    async fn logged_best_effort(
        &self,
        stream: &mut AsyncRustlsFtpStream,
        cmd: &str,
        expected: &[Status],
    ) {
        self.logger.emit(cmd.to_string(), LogKind::Command);
        match stream.custom_command(cmd.to_string(), expected).await {
            Ok(resp) => self.log_response_body(&resp.body),
            // Optional capability negotiation may be unsupported. Preserve
            // the wire reply without presenting it as a connection failure.
            Err(suppaftp::FtpError::UnexpectedResponse(resp)) if unsupported_reply(resp.status) => {
                self.log_response_body(&resp.body);
            }
            Err(err) => self.logger.emit(format!("{err}"), LogKind::Error),
        }
    }

    /// Asks for the server's features, answering with whatever it listed.
    async fn logged_feat(&self, stream: &mut AsyncRustlsFtpStream) -> String {
        self.logger.emit("FEAT".to_string(), LogKind::Command);
        match stream.custom_command("FEAT".to_string(), &[]).await {
            Ok(resp) | Err(suppaftp::FtpError::UnexpectedResponse(resp)) => {
                self.log_response_body(&resp.body);
                String::from_utf8_lossy(&resp.body).into_owned()
            }
            Err(err) => {
                self.logger.emit(format!("{err}"), LogKind::Error);
                String::new()
            }
        }
    }

    fn build_tls_config(
        allow_invalid_cert: bool,
        ca_cert_path: Option<&str>,
    ) -> AnyhowResult<ClientConfig> {
        if allow_invalid_cert {
            Ok(ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoCertVerification))
                .with_no_client_auth())
        } else {
            let mut root_store = rustls::RootCertStore::empty();
            root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            if let Some(path) = ca_cert_path {
                let pem_bytes = std::fs::read(path)
                    .with_context(|| format!("failed to read CA certificate \"{path}\""))?;
                for cert in rustls_pki_types::CertificateDer::pem_slice_iter(&pem_bytes) {
                    let cert =
                        cert.with_context(|| format!("failed to parse CA certificate \"{path}\""))?;
                    root_store
                        .add(cert)
                        .with_context(|| format!("invalid CA certificate \"{path}\""))?;
                }
            }
            Ok(ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth())
        }
    }

    async fn ensure_dir(stream: &mut AsyncRustlsFtpStream, path: &str) -> BackendResult<()> {
        // The common case needs one command and no permission to enter the
        // new directory (upload-only accounts may allow MKD but deny CWD).
        match stream.mkdir(path).await {
            Ok(_) => return Ok(()),
            Err(suppaftp::FtpError::UnexpectedResponse(response))
                if response.status == Status::FileUnavailable => {}
            Err(error) => return Err(error.into()),
        }
        let original = stream.pwd().await.context("saving working directory")?;
        let result = Self::ensure_dir_segments(stream, path).await;
        let restored = stream
            .cwd(&original)
            .await
            .context("restoring working directory");
        result?;
        restored?;
        Ok(())
    }

    async fn ensure_dir_segments(
        stream: &mut AsyncRustlsFtpStream,
        path: &str,
    ) -> BackendResult<()> {
        if path.starts_with('/') {
            stream.cwd("/").await.context("cwd to root")?;
        }
        for segment in path.split('/').filter(|s| !s.is_empty()) {
            if stream.cwd(segment).await.is_err() {
                stream.mkdir(segment).await.context("mkd segment")?;
                stream.cwd(segment).await.context("cwd into new segment")?;
            }
        }
        Ok(())
    }

    fn spawn_keep_alive(
        stream: Arc<AsyncMutex<Option<AsyncRustlsFtpStream>>>,
        busy: Arc<AtomicUsize>,
        connected: Arc<AtomicBool>,
        period: Duration,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.tick().await; // first tick is immediate; skip it
            loop {
                interval.tick().await;
                if busy.load(Ordering::SeqCst) > 0 {
                    continue;
                }
                let mut guard = stream.lock().await;
                match guard.as_mut() {
                    Some(s) => {
                        if !matches!(
                            tokio::time::timeout(GRACEFUL_IO_TIMEOUT, s.noop()).await,
                            Ok(Ok(()))
                        ) {
                            *guard = None;
                            connected.store(false, Ordering::SeqCst);
                            break;
                        }
                    }
                    None => break,
                }
            }
        })
    }

    async fn with_stream<F, T>(&self, f: F) -> BackendResult<T>
    where
        F: for<'a> FnOnce(
            &'a mut AsyncRustlsFtpStream,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = BackendResult<T>> + Send + 'a>,
        >,
    {
        let _busy = BusyGuard::enter(&self.busy);
        let mut operation = StreamOperation {
            slot: self.stream.lock().await,
            connected: &self.connected,
            reusable: false,
        };
        let stream = operation.slot.as_mut().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })?;
        let result = f(stream).await;
        // A refusal is the server's complete reply, so the connection stays in
        // step: MLSD can fall back to LIST on it, and a missing file does not
        // cost a reconnect. Other failures discard it conservatively.
        operation.reusable = result.is_ok() || result.as_ref().is_err_and(refused_by_server);
        if let Err(error) = &result {
            self.logger.emit(format!("{error:#}"), LogKind::Error);
        }
        result
    }

    fn data_channel(&self) -> BackendResult<DataChannel> {
        self.data.clone().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })
    }
}

#[async_trait]
impl ProtocolBackend for FtpBackend {
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
        self.data = None;
        let mut guard = self.stream.lock().await;
        if let Some(mut stream) = guard.take() {
            let _ = tokio::time::timeout(GRACEFUL_IO_TIMEOUT, stream.quit()).await;
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
        self.logger.event(key, params, kind);
    }

    async fn list(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        self.list_entries(path, true).await
    }

    /// A link stays a file here, so a recursive delete removes the link
    /// instead of emptying the folder it leads to.
    async fn list_for_recursive(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        self.list_entries(path, false).await
    }

    async fn mkdir(&mut self, path: &str) -> BackendResult<()> {
        self.logger.emit(format!("MKD {path}"), LogKind::Command);
        let target = path.to_string();
        let made = self
            .with_stream(move |s| Box::pin(async move { Self::ensure_dir(s, &target).await }))
            .await;
        // An existing folder already counts as made, so a plain 550 left
        // over is the server refusing to create one.
        match made {
            Err(error)
                if refused_by_server(&error) && crate::ipc::CommandError::unexplained(&error) =>
            {
                Err(error.context(crate::ipc::CommandError::new(
                    ErrorCode::PermissionDenied,
                    format!("The server refused to create {path}"),
                )))
            }
            made => made,
        }
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        if self.exists(path).await? {
            return Err(super::fail(
                ErrorCode::AlreadyExists,
                format!("{path} already exists on the server; it was not replaced"),
            ));
        }
        // An empty APPE creates a missing file and adds nothing to one that
        // appeared since the check, so no content is ever replaced. STOR would
        // truncate that racing file, and so would staging followed by RNTO; a
        // refused APPE therefore never falls back to either. The price is that
        // success does not prove the file is new: it may be the racing one.
        let target = path.to_string();
        let data = self.data_channel()?;
        let created = self
            .with_stream(move |s| {
                Box::pin(async move {
                    let upload = UploadData(Some(
                        data.open(s, format!("APPE {target}"), STORE_OPEN).await?,
                    ));
                    upload.finish(s).await
                })
            })
            .await;
        match created {
            Err(error)
                if error.chain().any(|cause| {
                    matches!(
                        cause.downcast_ref::<suppaftp::FtpError>(),
                        Some(suppaftp::FtpError::UnexpectedResponse(response))
                            if matches!(response.status, Status::NotImplemented | Status::NotImplementedParameter)
                    )
                }) =>
            {
                Err(error.context(crate::ipc::CommandError::new(
                    ErrorCode::CreateUnsupported,
                    format!("The server does not support creating {path}"),
                )))
            }
            created => created,
        }
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> BackendResult<()> {
        if is_dir {
            self.remove_tree(path).await
        } else {
            self.remove_file(path).await
        }
    }

    /// RNTO replaces an existing file on most servers, but some refuse (IIS
    /// answers 550). That refusal is told apart from any other by both paths
    /// still standing, and the existing file is then set aside so the new one
    /// can take its name.
    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let Some(error) = self.rename_once(old_path, new_path).await? else {
            return Ok(());
        };
        // SIZE answers only for a file, so a folder in the way stays an error.
        if self.exists(new_path).await? && self.exists(old_path).await? {
            return super::replace_by_setting_aside(self, old_path, new_path).await;
        }
        Err(error.into())
    }

    /// FTP has no conditional rename, and RNTO replaces an existing file on
    /// most servers. Looking at the target right before RNFR leaves only the
    /// moment between the two for a racing file to be replaced in, instead of
    /// the whole upload that staged it. A refused RNTO is never retried as a
    /// replace: the file in the way may be another client's.
    async fn rename_no_replace(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let already_exists = || {
            super::fail(
                ErrorCode::AlreadyExists,
                format!("{new_path} already exists on the server; it was not replaced"),
            )
        };
        // A server that ignores case (IIS) finds the file itself under its new
        // spelling; only a file listed under exactly that name is in the way.
        let case_only = old_path.to_lowercase() == new_path.to_lowercase();
        if self.exists(new_path).await? && (!case_only || self.listed(new_path).await?) {
            return Err(already_exists());
        }
        let Some(error) = self.rename_once(old_path, new_path).await? else {
            return Ok(());
        };
        if !case_only && self.exists(new_path).await? {
            return Err(already_exists());
        }
        Err(error.into())
    }

    async fn read_range(&mut self, path: &str, offset: u64, len: usize) -> BackendResult<Vec<u8>> {
        let path = path.to_string();
        let data = self.data_channel()?;
        self.with_stream(move |s| {
            Box::pin(async move {
                // REST only positions the next RETR, so the transfer runs to end
                // of file. That is deliberately the whole contract: stopping a
                // RETR early means ABOR, and a mishandled abort desynchronises
                // the control channel for every command after it.
                if offset > 0 {
                    s.resume_transfer(offset as usize).await?;
                }
                let mut data_stream = data.open(s, format!("RETR {path}"), RETRIEVE_OPEN).await?;
                let mut bytes: Vec<u8> = Vec::with_capacity(len);
                let read: BackendResult<()> = async {
                    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
                    loop {
                        let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                        let n = tokio::time::timeout(
                            TRANSFER_STALL_TIMEOUT,
                            data_stream.stream().read(&mut buf[..read_len]),
                        )
                        .await
                        .context("stalled while reading from server")?
                        .context("reading from server")?;
                        if n == 0 {
                            return Ok(());
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        // Verification bytes cross the wire like any others, so
                        // they are paced by the same bandwidth limit.
                        crate::transfer::rate_limiter::shared()
                            .acquire(n as u64)
                            .await;
                        anyhow::ensure!(
                            bytes.len() <= len,
                            "The server sent more than the requested range"
                        );
                    }
                }
                .await;
                // A failed read leaves the data connection to be dropped rather
                // than finalised: the remainder length is unknown, so there is
                // nothing safe to drain. Only a read that reached EOF can settle
                // the transfer and keep the control channel in step.
                read?;
                tokio::time::timeout(TRANSFER_STALL_TIMEOUT, data_stream.settle_download(s))
                    .await
                    .context("download completion timed out")??;
                Ok(bytes)
            })
        })
        .await
    }

    async fn known_size(&mut self, path: &str) -> Option<u64> {
        let path = path.to_string();
        self.with_stream(move |s| {
            Box::pin(
                async move { Ok(optional_reply(s.size(&path).await)?.map(|size| size as u64)) },
            )
        })
        .await
        .ok()
        .flatten()
    }

    async fn upload(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()> {
        let (local_size, remote_size) =
            super::upload_start(self, local_path, remote_path, resume).await?;

        let remote_path = remote_path.to_string();
        let remote_path_for_op = remote_path.clone();
        let local_path = local_path.to_path_buf();
        let progress_for_op = progress.clone();
        let data = self.data_channel()?;
        let result = self
            .with_stream(move |s| {
                Box::pin(async move {
                    let mut file = tokio::fs::File::open(&local_path)
                        .await
                        .context("opening local file")?;
                    if resume && remote_size > 0 {
                        file.seek(std::io::SeekFrom::Start(remote_size))
                            .await
                            .context("seeking local file")?;
                    }
                    let command = if resume && remote_size > 0 {
                        "APPE"
                    } else {
                        "STOR"
                    };
                    let mut data_stream = UploadData(Some(
                        data.open(s, format!("{command} {remote_path_for_op}"), STORE_OPEN)
                            .await?,
                    ));
                    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
                    let mut transferred = remote_size;
                    loop {
                        let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                        let n = file
                            .read(&mut buf[..read_len])
                            .await
                            .context("reading local file")?;
                        if n == 0 {
                            break;
                        }
                        let written = tokio::time::timeout(
                            TRANSFER_STALL_TIMEOUT,
                            data_stream.stream().write_all(&buf[..n]),
                        )
                        .await
                        .context("stalled while writing to server")
                        .and_then(|written| written.context("writing to server"));
                        if let Err(error) = written {
                            return Err(upload_refusal(s, data_stream, error).await);
                        }
                        transferred += n as u64;
                        crate::transfer::rate_limiter::shared()
                            .acquire(n as u64)
                            .await;
                        progress_for_op(ProgressInfo::Progress {
                            bytes: transferred,
                            total: local_size,
                        });
                    }
                    data_stream.finish(s).await?;
                    super::transfer_file::validate_length(transferred, Some(local_size))?;
                    Ok(())
                })
            })
            .await;

        super::upload_finish(self, &remote_path, local_size, result, &progress).await
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
        super::transfer_file::report_outcome(&result, &progress);
        result
    }

    async fn download_to_writer(
        &mut self,
        remote_path: &str,
        writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> BackendResult<()> {
        let data = self.data_channel()?;
        let _busy = BusyGuard::enter(&self.busy);
        let mut operation = StreamOperation {
            slot: self.stream.lock().await,
            connected: &self.connected,
            reusable: false,
        };
        let s = operation.slot.as_mut().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })?;
        let mut data_stream = match data
            .open(s, format!("RETR {remote_path}"), RETRIEVE_OPEN)
            .await
        {
            Ok(stream) => stream,
            Err(error) => {
                operation.reusable = refused_by_server(&error);
                drop(operation);
                return Err(self.explain_refusal(remote_path, error).await);
            }
        };
        let mut buf = vec![0u8; COPY_CHUNK_SIZE];
        loop {
            let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
            let n = tokio::time::timeout(
                TRANSFER_STALL_TIMEOUT,
                data_stream.stream().read(&mut buf[..read_len]),
            )
            .await
            .context("stalled while reading from server")?
            .context("reading from server")?;
            if n == 0 {
                break;
            }
            writer
                .write_all(&buf[..n])
                .await
                .context("relaying to target")?;
            crate::transfer::rate_limiter::shared()
                .acquire(n as u64)
                .await;
        }
        tokio::time::timeout(TRANSFER_STALL_TIMEOUT, data_stream.settle_download(s))
            .await
            .context("download completion timed out")??;
        operation.reusable = true;
        Ok(())
    }

    async fn upload_from_reader(
        &mut self,
        reader: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> BackendResult<()> {
        let data = self.data_channel()?;
        let _busy = BusyGuard::enter(&self.busy);
        let mut operation = StreamOperation {
            slot: self.stream.lock().await,
            connected: &self.connected,
            reusable: false,
        };
        let s = operation.slot.as_mut().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })?;
        let mut data_stream = match data
            .open(s, format!("STOR {remote_path}"), STORE_OPEN)
            .await
        {
            Ok(stream) => UploadData(Some(stream)),
            Err(error) => {
                operation.reusable = refused_by_server(&error);
                return Err(error);
            }
        };
        let mut buf = vec![0u8; COPY_CHUNK_SIZE];
        loop {
            let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
            let n = reader
                .read(&mut buf[..read_len])
                .await
                .context("reading from source")?;
            if n == 0 {
                break;
            }
            let written = tokio::time::timeout(
                TRANSFER_STALL_TIMEOUT,
                data_stream.stream().write_all(&buf[..n]),
            )
            .await
            .context("stalled while writing to server")
            .and_then(|written| written.context("writing to server"));
            if let Err(error) = written {
                let error = upload_refusal(s, data_stream, error).await;
                operation.reusable = refused_by_server(&error);
                return Err(error);
            }
            crate::transfer::rate_limiter::shared()
                .acquire(n as u64)
                .await;
        }
        data_stream.finish(s).await?;
        operation.reusable = true;
        Ok(())
    }
}

#[cfg(test)]
#[path = "ftp_tests.rs"]
mod protocol_tests;
