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
use rustls_pki_types::pem::PemObject;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use suppaftp::Status;
use suppaftp::tokio::{
    AsyncDataStream, AsyncRustlsConnector, AsyncRustlsFtpStream, AsyncRustlsStream,
};
use suppaftp::types::FileType as FtpFileType;
use suppaftp::types::Mode as FtpMode;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(20);
const COPY_CHUNK_SIZE: usize = 64 * 1024;
const DATA_IDLE_TIMEOUT: Duration = Duration::from_secs(3);
const GRACEFUL_IO_TIMEOUT: Duration = Duration::from_secs(5);
const TRANSFER_STALL_TIMEOUT: Duration = Duration::from_secs(60);

async fn read_list_data(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    idle: Duration,
) -> BackendResult<Vec<u8>> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let mut entries = 0;
    loop {
        let n = tokio::time::timeout(idle, reader.read(&mut buf))
            .await
            .map_err(|_| super::fail(ErrorCode::TimedOut, "FTP LIST data stalled"))??;
        if n == 0 {
            return Ok(raw);
        }
        entries += buf[..n].iter().filter(|&&b| b == b'\n').count();
        if raw.len().saturating_add(n) > super::MAX_DIRECTORY_TEXT_BYTES
            || entries > super::MAX_DIRECTORY_ENTRIES
        {
            return Err(super::fail(
                ErrorCode::ResourceLimit,
                "FTP LIST exceeds its byte or entry budget",
            ));
        }
        raw.extend_from_slice(&buf[..n]);
    }
}

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

/// A STOR's data connection, reset rather than closed if it goes before the
/// upload finished — the pool cancelling it, most of all. A plain close lets
/// the kernel go on delivering whatever was still queued, which the server
/// takes as the rest of the file: it keeps writing it after the stop, and
/// answers nothing on the control connection, QUIT included, until the last
/// byte is in.
struct UploadData(Option<AsyncDataStream<AsyncRustlsStream>>);

impl UploadData {
    fn stream(&mut self) -> &mut AsyncDataStream<AsyncRustlsStream> {
        self.0
            .as_mut()
            .expect("upload data connection already handed over")
    }

    /// Ends the upload the ordinary way, once the whole file is written: the
    /// FIN goes out behind the last byte, then the server confirms the file.
    /// Until it has, dropping this still resets the connection, so a stop
    /// that lands while the last bytes are in flight still takes effect.
    async fn finish(mut self, control: &mut AsyncRustlsFtpStream) -> BackendResult<()> {
        tokio::time::timeout(TRANSFER_STALL_TIMEOUT, self.stream().shutdown())
            .await
            .context("upload shutdown timed out")?
            .context("closing the upload data connection")?;
        // The data connection is already shut; this only reads the verdict.
        tokio::time::timeout(
            TRANSFER_STALL_TIMEOUT,
            control.finalize_put_stream(tokio::io::sink()),
        )
        .await
        .context("upload completion timed out")??;
        // The server has the whole file, so closing takes nothing back now.
        self.0 = None;
        Ok(())
    }
}

impl Drop for UploadData {
    fn drop(&mut self) {
        if let Some(stream) = &self.0 {
            let _ = stream.get_ref().set_zero_linger();
        }
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

/// Whether the server turned a command away as one it does not implement,
/// rather than failing it over what it was asked to do.
fn command_refused(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<suppaftp::FtpError>(),
            Some(suppaftp::FtpError::UnexpectedResponse(response))
                if matches!(
                    response.status,
                    Status::BadCommand
                        | Status::BadArguments
                        | Status::NotImplemented
                        | Status::NotImplementedParameter
                )
        )
    })
}

pub struct FtpBackend {
    stream: Arc<AsyncMutex<Option<AsyncRustlsFtpStream>>>,
    connected: Arc<AtomicBool>,
    /// Listings come by MLSD, which names every entry, rather than by LIST,
    /// which many servers print without the names that start with a dot.
    mlsd: bool,
    busy: Arc<AtomicUsize>,
    keep_alive_handle: Option<tokio::task::JoinHandle<()>>,
    logger: BackendLogger,
    endpoint: String,
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
            busy: Arc::new(AtomicUsize::new(0)),
            keep_alive_handle: None,
            logger: BackendLogger::default(),
            endpoint: String::new(),
        }
    }
}

impl FtpBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn log_kind(&self, line: impl Into<LogText>, kind: LogKind) {
        self.logger.emit(line, kind);
    }

    /// Human-authored, translated log line — the frontend resolves `key` via
    /// `i18next` (`log.{key}`) against `params`. Never used for literal
    /// protocol wire text (commands, numeric-coded server replies), which
    /// stays untranslated via `log`/`log_kind` — see `LogText`'s doc comment.
    fn log_key(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.logger.event(key, params, kind);
    }

    fn log_response_body(&self, body: &[u8]) {
        let text = String::from_utf8_lossy(body);
        for line in text
            .split(['\r', '\n'])
            .map(str::trim)
            .filter(|l| !l.is_empty())
        {
            self.log_kind(line.to_string(), LogKind::Response);
        }
    }

    async fn logged_command(
        &self,
        stream: &mut AsyncRustlsFtpStream,
        cmd: String,
        display: impl Into<LogText>,
        expected: &[Status],
    ) -> BackendResult<suppaftp::types::Response> {
        self.log_kind(display, LogKind::Command);
        match stream.custom_command(cmd, expected).await {
            Ok(resp) => {
                self.log_response_body(&resp.body);
                Ok(resp)
            }
            Err(err) => {
                self.log_kind(format!("{err}"), LogKind::Error);
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
        self.log_kind(cmd.to_string(), LogKind::Command);
        match stream.custom_command(cmd.to_string(), expected).await {
            Ok(resp) => self.log_response_body(&resp.body),
            Err(err) => self.log_kind(format!("{err}"), LogKind::Error),
        }
    }

    /// Asks for the server's features, answering with whatever it listed.
    async fn logged_feat(&self, stream: &mut AsyncRustlsFtpStream) -> String {
        self.log_kind("FEAT".to_string(), LogKind::Command);
        match stream.custom_command("FEAT".to_string(), &[]).await {
            Ok(resp) | Err(suppaftp::FtpError::UnexpectedResponse(resp)) => {
                self.log_response_body(&resp.body);
                String::from_utf8_lossy(&resp.body).into_owned()
            }
            Err(err) => {
                self.log_kind(format!("{err}"), LogKind::Error);
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

    /// Runs a listing `command` — LIST or MLSD — for `path`, answering with
    /// the lines the server sent.
    async fn list_raw(
        stream: &mut AsyncRustlsFtpStream,
        command: &str,
        path: &str,
    ) -> BackendResult<Vec<String>> {
        let (_, mut data_stream) = tokio::time::timeout(
            GRACEFUL_IO_TIMEOUT,
            stream.custom_data_command(
                format!("{command} {path}"),
                &[Status::AboutToSend, Status::AlreadyOpen],
            ),
        )
        .await
        .with_context(|| format!("FTP {command} command timed out"))?
        .with_context(|| format!("{command} command failed"))?;

        let raw = read_list_data(&mut data_stream, DATA_IDLE_TIMEOUT).await?;

        tokio::time::timeout(
            GRACEFUL_IO_TIMEOUT,
            stream.close_data_connection(data_stream),
        )
        .await
        .with_context(|| format!("FTP {command} completion timed out"))?
        .with_context(|| format!("closing {command} data connection"))?;

        let text = String::from_utf8_lossy(&raw);
        Ok(text
            .split(['\r', '\n'])
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
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
        // Unsupported commands are complete negative replies; MLSD can fall
        // back to LIST on this socket. Other failures discard it conservatively.
        operation.reusable = result.is_ok() || result.as_ref().is_err_and(command_refused);
        result
    }

    /// Whether a file stands at `path`. SIZE answers in one control-channel
    /// round trip, with 550 for a name that is free — or a folder, which a file
    /// cannot be renamed over anyway. A server that does not implement SIZE is
    /// asked for the parent's listing instead.
    async fn exists(&mut self, path: &str) -> BackendResult<bool> {
        let probe = path.to_string();
        let size = self
            .with_stream(move |s| Box::pin(async move { Ok(s.size(&probe).await) }))
            .await?;
        match size {
            Ok(_) => return Ok(true),
            Err(suppaftp::FtpError::UnexpectedResponse(response))
                if response.status == Status::FileUnavailable =>
            {
                return Ok(false);
            }
            Err(_) => {}
        }
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let parent = if parent.is_empty() { "/" } else { parent };
        Ok(self
            .list(parent)
            .await?
            .iter()
            .any(|entry| entry.name == name))
    }

    /// The lines of `target`'s listing, by MLSD where the server offers it.
    async fn fetch_listing(&self, target: &str) -> BackendResult<Vec<String>> {
        let command = if self.mlsd { "MLSD" } else { "LIST" };
        self.log_kind(format!("{command} {target}"), LogKind::Command);
        let target = target.to_owned();
        self.with_stream(move |s| {
            Box::pin(async move { Self::list_raw(s, command, &target).await })
        })
        .await
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
                let path = path.to_string();
                return self
                    .with_stream(move |s| Box::pin(async move { Ok(s.rm(&path).await?) }))
                    .await;
            }
            let entries = self.list(path).await?;
            for entry in entries {
                let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
                self.remove_with_depth(&child, entry.is_directory, depth + 1)
                    .await?;
            }
            let path = path.to_string();
            self.with_stream(move |s| Box::pin(async move { Ok(s.rmdir(&path).await?) }))
                .await
        })
    }
}

#[async_trait]
impl ProtocolBackend for FtpBackend {
    async fn connect(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.disconnect().await.ok();
        let crate::protocol::config::ConnectionConfig::Ftp(config) = config else {
            return Err(anyhow!("FTP backend received a non-FTP configuration"));
        };
        self.endpoint = serde_json::json!([
            "ftp",
            config.host.to_lowercase(),
            config.port,
            config.user,
            config.secure
        ])
        .to_string();
        let host = config.host.clone();
        let port = config.port;
        let user = config.user.clone();
        let password = config.password.clone();
        let secure = config.secure;
        let allow_invalid_cert = config.allow_invalid_cert;
        let ca_cert_path = config.ca_cert_path.clone();
        let proxy = config.common.proxy.clone();
        let active_mode = config.active_mode && proxy.is_none();
        // `0` is a deliberate, explicit "no timeout" — must not collapse it
        // into the 20s default the way `timeout || 20000` would in JS.
        let timeout_ms = config.common.timeout_ms;

        let addr = format!("{host}:{port}");
        self.log_key(
            "connecting",
            serde_json::json!({ "addr": &addr }),
            LogKind::Status,
        );

        let this = &*self;
        let connect_fut = async {
            let tcp = crate::protocol::transport::connect(&host, port, proxy.as_ref())
                .await
                .context("proxy/TCP connect failed")?;
            let ipv6 = if proxy.is_none() {
                tcp.peer_addr()?.is_ipv6()
            } else {
                host.parse::<std::net::Ipv6Addr>().is_ok()
            };
            let mut stream = AsyncRustlsFtpStream::connect_with_stream(tcp)
                .await
                .context("FTP handshake failed")?;
            // The literal server welcome banner — a real, wire-level line,
            // same as FileZilla's own "Response: 220 ..." right after connect.
            if let Some(welcome) = stream.get_welcome_msg() {
                this.log_response_body(welcome.as_bytes());
            }
            stream.set_mode(if active_mode {
                FtpMode::Active
            } else if ipv6 {
                FtpMode::ExtendedPassive
            } else {
                FtpMode::Passive
            });
            // PASV addresses frequently name a private interface behind NAT.
            // Data must go to the control peer, not an arbitrary advertised IP.
            stream.set_passive_nat_workaround(true);
            if secure {
                this.log_key("tlsInit", serde_json::json!({}), LogKind::Status);
                if allow_invalid_cert {
                    this.log_kind(
                        "WARNING: TLS certificate verification is disabled for this connection (allowInvalidCert) — the server's identity is not being checked.".to_string(),
                        LogKind::Error,
                    );
                }
                let tls_config =
                    Self::build_tls_config(allow_invalid_cert, ca_cert_path.as_deref())?;
                let connector: AsyncRustlsConnector =
                    tokio_rustls::TlsConnector::from(Arc::new(tls_config)).into();
                stream = stream
                    .into_secure(connector, &host)
                    .await
                    .context("TLS handshake failed")?;
                this.log_key("tlsEstablished", serde_json::json!({}), LogKind::Response);
            }
            if let Some(proxy) = proxy.clone() {
                let host_for_data = host.clone();
                stream = stream.passive_stream_builder(move |addr| {
                    let proxy = proxy.clone();
                    let host_for_data = host_for_data.clone();
                    Box::pin(async move {
                        crate::protocol::transport::connect(
                            &host_for_data,
                            addr.port(),
                            Some(&proxy),
                        )
                        .await
                        .map_err(|e| {
                            suppaftp::FtpError::ConnectionError(std::io::Error::other(
                                e.to_string(),
                            ))
                        })
                    })
                });
            }
            this.logged_best_effort(&mut stream, "OPTS UTF8 ON", &[Status::CommandOk])
                .await;

            let user_cmd = format!("USER {user}");
            let user_resp = this
                .logged_command(
                    &mut stream,
                    user_cmd.clone(),
                    user_cmd,
                    &[Status::LoggedIn, Status::NeedPassword],
                )
                .await
                .context("login failed")?;
            if user_resp.status == Status::NeedPassword {
                // Never log the real password — the command line shows a
                // fixed mask instead, same as FileZilla's own display.
                this.logged_command(
                    &mut stream,
                    format!("PASS {password}"),
                    "PASS ****",
                    &[Status::LoggedIn],
                )
                .await
                .context("login failed")?;
            }

            this.logged_best_effort(&mut stream, "SYST", &[Status::Name])
                .await;
            let feat = this.logged_feat(&mut stream).await;
            this.logged_best_effort(&mut stream, "OPTS UTF8 ON", &[Status::CommandOk])
                .await;

            stream
                .transfer_type(FtpFileType::Binary)
                .await
                .context("setting binary transfer type failed")?;
            Ok::<_, anyhow::Error>((stream, feat))
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
        let (stream, feat) = match outcome {
            Ok(connected) => connected,
            Err(err) => {
                self.log_key(
                    "connectFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err);
            }
        };

        self.log_key("connected", serde_json::json!({}), LogKind::Response);
        self.mlsd = feat_offers_mlsd(&feat);
        *self.stream.lock().await = Some(stream);
        self.connected.store(true, Ordering::SeqCst);
        self.keep_alive_handle = Some(Self::spawn_keep_alive(
            self.stream.clone(),
            self.busy.clone(),
            self.connected.clone(),
            KEEP_ALIVE_INTERVAL,
        ));
        Ok(())
    }

    async fn disconnect(&mut self) -> BackendResult<()> {
        if let Some(handle) = self.keep_alive_handle.take() {
            handle.abort();
        }
        self.connected.store(false, Ordering::SeqCst);
        let mut guard = self.stream.lock().await;
        if let Some(mut stream) = guard.take() {
            let _ = tokio::time::timeout(GRACEFUL_IO_TIMEOUT, stream.quit()).await;
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
        let mut listing = self.fetch_listing(&target).await;
        // A server may announce MLST and still turn MLSD away; LIST answers.
        if self.mlsd && listing.as_ref().is_err_and(command_refused) {
            self.mlsd = false;
            listing = self.fetch_listing(&target).await;
        }
        let raw_lines = match listing {
            Ok(lines) => lines,
            Err(err) => {
                self.log_key(
                    "listFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err);
            }
        };
        if raw_lines.len() > super::MAX_DIRECTORY_ENTRIES
            || raw_lines.iter().map(String::len).sum::<usize>() > super::MAX_DIRECTORY_TEXT_BYTES
        {
            anyhow::bail!(crate::ipc::CommandError::new(
                crate::ipc::ErrorCode::ResourceLimit,
                "FTP directory listing exceeds the configured limit",
            ));
        }
        let now = Utc::now();
        let mut entries = Vec::with_capacity(raw_lines.len());
        for line in raw_lines {
            let parsed = if self.mlsd {
                list_parse::parse_mlsd_line(&line)
            } else {
                list_parse::parse_line(&line, now)
            };
            let Some(raw) = parsed else {
                continue;
            };
            if !is_safe_path_segment(&raw.name) {
                self.log_key(
                    "skippedUnsafeEntry",
                    serde_json::json!({ "name": raw.name }),
                    LogKind::Status,
                );
                continue;
            }
            entries.push(EntryInfo {
                name: raw.name,
                is_directory: raw.is_directory,
                size: raw.size,
                modified_at: raw.modified_at.map(|d| d.to_rfc3339()),
                permissions: raw.permissions,
                owner: raw.owner,
                group: raw.group,
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
        let path = path.to_string();
        self.with_stream(move |s| Box::pin(async move { Self::ensure_dir(s, &path).await }))
            .await
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        let path = path.to_string();
        self.with_stream(move |s| {
            Box::pin(async move {
                let mut empty = tokio::io::empty();
                s.put_file(&path, &mut empty).await?;
                Ok(())
            })
        })
        .await
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> BackendResult<()> {
        self.remove_with_depth(path, is_dir, 0).await
    }
    fn supports_empty_directory_remove(&self) -> bool {
        true
    }
    async fn remove_empty_directory(&mut self, path: &str) -> BackendResult<()> {
        let path = path.to_string();
        self.with_stream(move |stream| Box::pin(async move { Ok(stream.rmdir(&path).await?) }))
            .await
    }

    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let old_path = old_path.to_string();
        let new_path = new_path.to_string();
        self.with_stream(move |s| {
            Box::pin(async move { Ok(s.rename(&old_path, &new_path).await?) })
        })
        .await
    }

    /// FTP has no conditional rename, and RNTO replaces an existing file on
    /// most servers. Looking at the target right before RNFR leaves only the
    /// moment between the two for a racing file to be replaced in, instead of
    /// the whole upload that staged it.
    async fn rename_no_replace(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        anyhow::ensure!(
            !self.exists(new_path).await?,
            "{new_path} already exists on the server; it was not replaced"
        );
        self.rename(old_path, new_path).await
    }

    async fn size(&mut self, path: &str) -> u64 {
        self.known_size(path).await.unwrap_or(0)
    }

    async fn read_range(&mut self, path: &str, offset: u64, len: usize) -> BackendResult<Vec<u8>> {
        let path = path.to_string();
        self.with_stream(move |s| {
            Box::pin(async move {
                // REST only positions the next RETR, so the transfer runs to end
                // of file. That is deliberately the whole contract: stopping a
                // RETR early means ABOR, and a mishandled abort desynchronises
                // the control channel for every command after it.
                if offset > 0 {
                    s.resume_transfer(offset as usize).await?;
                }
                let mut data_stream = s.retr_as_stream(&path).await?;
                let mut bytes: Vec<u8> = Vec::with_capacity(len);
                let read: BackendResult<()> = async {
                    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
                    loop {
                        let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                        let n = tokio::time::timeout(
                            TRANSFER_STALL_TIMEOUT,
                            data_stream.read(&mut buf[..read_len]),
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
                tokio::time::timeout(TRANSFER_STALL_TIMEOUT, s.finalize_retr_stream(data_stream))
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
            Box::pin(async move { Ok(s.size(&path).await.ok().map(|v| v as u64)) })
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

        let remote_path = remote_path.to_string();
        let remote_path_for_op = remote_path.clone();
        let local_path = local_path.to_path_buf();
        let progress_for_op = progress.clone();
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
                    let mut data_stream = UploadData(Some(if resume && remote_size > 0 {
                        s.append_with_stream(&remote_path_for_op).await?
                    } else {
                        s.put_with_stream(&remote_path_for_op).await?
                    }));
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
                        tokio::time::timeout(
                            TRANSFER_STALL_TIMEOUT,
                            data_stream.stream().write_all(&buf[..n]),
                        )
                        .await
                        .context("stalled while writing to server")?
                        .context("writing to server")?;
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
                    Ok(())
                })
            })
            .await;

        let result = match result {
            Ok(()) => {
                let actual = self.known_size(&remote_path).await;
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
        let _lease = super::transfer_file::reserve(local_path)?;
        let _mutation = crate::local_fs::mutations::guard().read().await;
        crate::local_fs::mutations::validate_download_name(local_path)?;
        crate::local_fs::filesystem_safety::validate_write_destination(local_path).await?;
        let remote_size = self.known_size(remote_path).await;
        let version_path = remote_path.to_string();
        let version = self
            .with_stream(move |s| {
                Box::pin(async move {
                    Ok(s.mdtm(&version_path)
                        .await
                        .ok()
                        .map(|date| date.to_string()))
                })
            })
            .await
            .ok()
            .flatten();
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

        let remote_path_owned = remote_path.to_string();
        let local_path_owned = local_path.to_path_buf();
        let partial_path_owned = partial_path.clone();
        let progress_for_op = progress.clone();
        let result = self
            .with_stream(move |s| {
                Box::pin(async move {
                    let mut file = tokio::fs::File::from_std(super::transfer_file::open_artifact(
                        &partial_path_owned,
                        false,
                    )?);

                    if start_at > 0 {
                        s.resume_transfer(start_at as usize).await?;
                        file.seek(std::io::SeekFrom::Start(start_at))
                            .await
                            .context("seeking local file")?;
                    }
                    let mut data_stream = s.retr_as_stream(&remote_path_owned).await?;
                    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
                    let mut transferred = start_at;
                    loop {
                        let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                        let read_result = tokio::time::timeout(
                            TRANSFER_STALL_TIMEOUT,
                            data_stream.read(&mut buf[..read_len]),
                        )
                        .await
                        .context("stalled while reading from server")?;
                        let n = read_result.context("reading from server")?;
                        if n == 0 {
                            break; // clean EOF from a well-behaved server
                        }
                        file.write_all(&buf[..n])
                            .await
                            .context("writing local file")?;
                        transferred += n as u64;
                        crate::transfer::rate_limiter::shared()
                            .acquire(n as u64)
                            .await;
                        progress_for_op(ProgressInfo::Progress {
                            bytes: transferred,
                            total: remote_size.unwrap_or(0),
                        });
                        if let Some(size) = remote_size
                            && transferred > size
                        {
                            return Err(super::fail(
                                ErrorCode::IntegrityMismatch,
                                format!("The server sent more than the advertised {size} bytes"),
                            ));
                        }
                    }
                    file.flush().await.context("flushing local file")?;
                    tokio::time::timeout(
                        TRANSFER_STALL_TIMEOUT,
                        s.finalize_retr_stream(data_stream),
                    )
                    .await
                    .context("download completion timed out")??;
                    super::transfer_file::validate_length(transferred, remote_size)?;
                    drop(file);
                    super::transfer_file::commit(&partial_path_owned, &local_path_owned).await?;
                    Ok(())
                })
            })
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
        let mut data_stream = s.retr_as_stream(remote_path).await?;
        let mut buf = vec![0u8; COPY_CHUNK_SIZE];
        loop {
            let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
            let n = tokio::time::timeout(
                TRANSFER_STALL_TIMEOUT,
                data_stream.read(&mut buf[..read_len]),
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
        tokio::time::timeout(TRANSFER_STALL_TIMEOUT, s.finalize_retr_stream(data_stream))
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
        let mut data_stream = UploadData(Some(s.put_with_stream(remote_path).await?));
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
            tokio::time::timeout(
                TRANSFER_STALL_TIMEOUT,
                data_stream.stream().write_all(&buf[..n]),
            )
            .await
            .context("stalled while writing to server")?
            .context("writing to server")?;
            crate::transfer::rate_limiter::shared()
                .acquire(n as u64)
                .await;
        }
        data_stream.finish(s).await?;
        operation.reusable = true;
        Ok(())
    }
}

#[derive(Debug)]
struct NoCertVerification;

impl rustls::client::danger::ServerCertVerifier for NoCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &rustls_pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
#[path = "ftp_tests.rs"]
mod protocol_tests;
