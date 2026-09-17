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
    AsyncDataStream, AsyncRustlsConnector, AsyncRustlsFtpStream, AsyncRustlsStream,
};
use suppaftp::types::FileType as FtpFileType;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

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
/// Preliminary replies that open a download's or an upload's data transfer.
const RETRIEVE_OPEN: &[Status] = &[Status::AboutToSend, Status::AlreadyOpen];
const STORE_OPEN: &[Status] = &[Status::AlreadyOpen, Status::AboutToSend];

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
            || entries > super::MAX_RAW_DIRECTORY_ENTRIES
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

/// Whether the server completes a TLS handshake on a fresh connection, as an
/// implicit FTPS server does before it sends any greeting.
async fn answers_tls(
    host: &str,
    port: u16,
    proxy: Option<&crate::protocol::transport::ProxyConfig>,
) -> bool {
    let Ok(config) = FtpBackend::build_tls_config(true, None) else {
        return false;
    };
    let Ok(name) = ServerName::try_from(host.to_owned()) else {
        return false;
    };
    let probe = async {
        let tcp = crate::protocol::transport::connect(host, port, proxy).await?;
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        anyhow::Ok(connector.connect(name, tcp).await?)
    };
    matches!(
        tokio::time::timeout(IMPLICIT_PROBE_WAIT, probe).await,
        Ok(Ok(_))
    )
}

/// Why an upload's data connection broke. A server that runs out of room
/// closes it, and gives the reason (552) on the control connection.
async fn upload_refusal(
    control: &mut AsyncRustlsFtpStream,
    data: UploadData,
    error: anyhow::Error,
) -> anyhow::Error {
    drop(data);
    match tokio::time::timeout(
        GRACEFUL_IO_TIMEOUT,
        control.read_response_in(&[Status::ClosingDataConnection, Status::RequestedFileActionOk]),
    )
    .await
    {
        Ok(Err(reply @ suppaftp::FtpError::UnexpectedResponse(_))) => {
            anyhow::Error::from(reply).context(format!("{error:#}"))
        }
        _ => error,
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

/// The port in a `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)` reply. The
/// address is not used: data goes to the control connection's peer.
fn pasv_port(reply: &str) -> Option<u16> {
    reply
        .get(4..)?
        .split(|c: char| !c.is_ascii_digit() && c != ',')
        .find_map(|group| {
            let numbers = group
                .split(',')
                .map(str::parse::<u8>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            match numbers[..] {
                [_, _, _, _, high, low] => Some(u16::from(high) << 8 | u16::from(low)),
                _ => None,
            }
        })
}

/// The port in a `229 Entering Extended Passive Mode (|||port|)` reply, whose
/// delimiter is whatever character follows the parenthesis.
fn epsv_port(reply: &str) -> Option<u16> {
    let inner = &reply[reply.find('(')? + 1..];
    let delimiter = inner.chars().next()?;
    inner.split(delimiter).nth(3)?.parse().ok()
}

/// The TLS session cache of one FTPS connection, counting the TLS 1.3 tickets
/// it holds. rustls spends each ticket once, and a server that requires data
/// connections to resume the control session (vsftpd does by default) refuses
/// one that has none left with 522.
#[derive(Debug)]
struct SessionTickets {
    cache: rustls::client::ClientSessionMemoryCache,
    held: std::sync::atomic::AtomicUsize,
    inserted: tokio::sync::Notify,
    /// Cleared once a server was seen not to send a ticket in time, so no
    /// upload waits for one again.
    arrive: AtomicBool,
}

impl SessionTickets {
    fn new() -> Self {
        Self {
            // rustls' own default. The cache sizes its server slots from
            // this, and too few leave no room for the session to resume.
            cache: rustls::client::ClientSessionMemoryCache::new(256),
            held: std::sync::atomic::AtomicUsize::new(0),
            inserted: tokio::sync::Notify::new(),
            arrive: AtomicBool::new(true),
        }
    }

    /// A download reads what its data connection receives, the server's new
    /// ticket included, but an upload only writes. Reading after the upload's
    /// handshake takes that ticket in, so the next data connection has one.
    async fn replenish(&self, tls: &mut tokio_rustls::client::TlsStream<tokio::net::TcpStream>) {
        let tls13 = tls.get_ref().1.protocol_version() == Some(rustls::ProtocolVersion::TLSv1_3);
        if !tls13 || self.held.load(Ordering::SeqCst) > 0 || !self.arrive.load(Ordering::SeqCst) {
            return;
        }
        let inserted = self.inserted.notified();
        tokio::pin!(inserted);
        inserted.as_mut().enable();
        if self.held.load(Ordering::SeqCst) > 0 {
            return;
        }
        // No application data comes before the file does: a server sends
        // nothing on an upload's data connection.
        let mut byte = [0u8; 1];
        tokio::select! {
            _ = &mut inserted => {}
            _ = tls.read(&mut byte) => {}
            _ = tokio::time::sleep(TICKET_WAIT) => self.arrive.store(false, Ordering::SeqCst),
        }
    }
}

impl rustls::client::ClientSessionStore for SessionTickets {
    fn set_kx_hint(&self, server_name: ServerName<'static>, group: rustls::NamedGroup) {
        self.cache.set_kx_hint(server_name, group);
    }
    fn kx_hint(&self, server_name: &ServerName<'_>) -> Option<rustls::NamedGroup> {
        self.cache.kx_hint(server_name)
    }
    fn set_tls12_session(
        &self,
        server_name: ServerName<'static>,
        value: rustls::client::Tls12ClientSessionValue,
    ) {
        self.cache.set_tls12_session(server_name, value);
    }
    fn tls12_session(
        &self,
        server_name: &ServerName<'_>,
    ) -> Option<rustls::client::Tls12ClientSessionValue> {
        self.cache.tls12_session(server_name)
    }
    fn remove_tls12_session(&self, server_name: &ServerName<'static>) {
        self.cache.remove_tls12_session(server_name);
    }
    fn insert_tls13_ticket(
        &self,
        server_name: ServerName<'static>,
        value: rustls::client::Tls13ClientSessionValue,
    ) {
        self.cache.insert_tls13_ticket(server_name, value);
        // The cache keeps at most eight and drops the oldest.
        let _ = self
            .held
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                Some((held + 1).min(8))
            });
        self.inserted.notify_waiters();
    }
    fn take_tls13_ticket(
        &self,
        server_name: &ServerName<'static>,
    ) -> Option<rustls::client::Tls13ClientSessionValue> {
        let ticket = self.cache.take_tls13_ticket(server_name);
        if ticket.is_some() {
            let _ = self
                .held
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                    held.checked_sub(1)
                });
        } else {
            self.held.store(0, Ordering::SeqCst);
        }
        ticket
    }
}

/// Opens the data connections of one control connection.
///
/// suppaftp starts the TLS handshake on a passive data connection before it
/// reads the reply to the command that asked for it. When that reply is a
/// refusal (RETR of a missing file, MLSD of a folder that may not be read) no
/// one answers the handshake, and the operation hung until it timed out. The
/// handshake here runs alongside the wait for the reply, so a refusal ends it.
#[derive(Clone)]
struct DataChannel {
    /// Where a proxy connects data connections to. Direct ones go to the
    /// control connection's peer, whatever address PASV names: behind NAT it
    /// is often a private one.
    host: String,
    proxy: Option<super::transport::ProxyConfig>,
    /// Built from the control connection's own TLS settings, whose session
    /// cache lets the data connection resume that session.
    tls: Option<(tokio_rustls::TlsConnector, ServerName<'static>)>,
    tickets: Arc<SessionTickets>,
    /// The server's address. The control connection's own peer is the
    /// loopback relay when the site has an encoding.
    peer: std::net::IpAddr,
    encoding: Option<&'static encoding_rs::Encoding>,
    active: bool,
    /// EPSV instead of PASV: over IPv6, or once the server turned PASV away.
    extended: Arc<AtomicBool>,
}

impl DataChannel {
    async fn open(
        &self,
        control: &mut AsyncRustlsFtpStream,
        command: String,
        expected: &[Status],
    ) -> BackendResult<AsyncDataStream<AsyncRustlsStream>> {
        if self.active {
            return Ok(control.custom_data_command(command, expected).await?.1);
        }
        let port = self.passive_port(control).await?;
        let peer = self.peer;
        let connect = async {
            match &self.proxy {
                Some(proxy) => super::transport::connect(&self.host, port, Some(proxy)).await,
                None => tokio::net::TcpStream::connect((peer, port))
                    .await
                    .with_context(|| format!("could not connect to {peer}:{port}")),
            }
        };
        let tcp = tokio::time::timeout(TRANSFER_STALL_TIMEOUT, connect)
            .await
            .context("FTP data connection timed out")?
            .context("opening the FTP data connection")?;
        let Some((connector, name)) = self.tls.clone() else {
            control.custom_command(command, expected).await?;
            return Ok(AsyncDataStream::Tcp(tcp));
        };
        let upload = command.starts_with("STOR ") || command.starts_with("APPE ");
        // tokio-rustls builds the TLS connection, spending a session ticket,
        // as soon as `connect` is called; the async block defers that until
        // the handshake is really started.
        let handshake = async move { connector.connect(name, tcp).await };
        tokio::pin!(handshake);
        let reply = control.custom_command(command, expected);
        tokio::pin!(reply);
        let mut secured = None;
        // Most servers reply before they take the handshake, and starting it
        // spends a session ticket even when the reply turns out a refusal.
        // A server that wants the handshake first gets it after a moment.
        let early = tokio::select! {
            reply = &mut reply => Some(reply),
            _ = tokio::time::sleep(HANDSHAKE_FIRST_WAIT) => None,
        };
        // Servers differ on whether the reply or the handshake comes first.
        let reply = match early {
            Some(reply) => reply,
            None => loop {
                tokio::select! {
                    reply = &mut reply => break reply,
                    done = &mut handshake, if secured.is_none() => secured = Some(done),
                }
            },
        };
        // A refusal drops the handshake that is still waiting for an answer.
        reply?;
        let tls = match secured {
            Some(done) => done,
            None => tokio::time::timeout(TRANSFER_STALL_TIMEOUT, handshake)
                .await
                .context("FTP data TLS handshake timed out")?,
        }
        .context("TLS handshake failed on the FTP data connection")?;
        let mut tls = tls;
        if upload {
            self.tickets.replenish(&mut tls).await;
        }
        Ok(AsyncDataStream::Ssl(Box::new(AsyncRustlsStream::from(tls))))
    }

    async fn passive_port(&self, control: &mut AsyncRustlsFtpStream) -> BackendResult<u16> {
        if !self.extended.load(Ordering::SeqCst) {
            match control.custom_command("PASV", &[Status::PassiveMode]).await {
                Ok(reply) => {
                    return pasv_port(&reply.as_string().unwrap_or_default())
                        .ok_or_else(|| anyhow!("Unreadable reply to PASV"));
                }
                Err(error) => {
                    let error = anyhow::Error::from(error);
                    if !command_refused(&error) {
                        return Err(error);
                    }
                    // Some servers only speak EPSV, which works over IPv4 too.
                    self.extended.store(true, Ordering::SeqCst);
                }
            }
        }
        let reply = control
            .custom_command("EPSV", &[Status::ExtendedPassiveMode])
            .await?;
        epsv_port(&reply.as_string().unwrap_or_default())
            .ok_or_else(|| anyhow!("Unreadable reply to EPSV"))
    }
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
            // Optional capability negotiation may be unsupported. Preserve
            // the wire reply without presenting it as a connection failure.
            Err(suppaftp::FtpError::UnexpectedResponse(resp))
                if matches!(
                    resp.status,
                    Status::BadCommand
                        | Status::BadArguments
                        | Status::NotImplemented
                        | Status::NotImplementedParameter
                ) =>
            {
                self.log_response_body(&resp.body);
            }
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

    /// Runs a listing `command` — LIST or MLSD — for `path`, answering with
    /// the lines the server sent.
    async fn list_raw(
        stream: &mut AsyncRustlsFtpStream,
        data: &DataChannel,
        command: &str,
        path: &str,
    ) -> BackendResult<Vec<String>> {
        let mut data_stream = tokio::time::timeout(
            GRACEFUL_IO_TIMEOUT,
            data.open(
                stream,
                format!("{command} {path}"),
                &[Status::AboutToSend, Status::AlreadyOpen],
            ),
        )
        .await
        .with_context(|| format!("FTP {command} command timed out"))?
        .with_context(|| format!("{command} command failed"))?;

        let raw = read_list_data(&mut data_stream, DATA_IDLE_TIMEOUT).await?;
        let encoding = data.encoding;

        tokio::time::timeout(
            GRACEFUL_IO_TIMEOUT,
            stream.close_data_connection(data_stream),
        )
        .await
        .with_context(|| format!("FTP {command} completion timed out"))?
        .with_context(|| format!("closing {command} data connection"))?;

        let text = super::ftp_charset::decode(encoding, &raw);
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
        // A refusal is the server's complete reply, so the connection stays in
        // step: MLSD can fall back to LIST on it, and a missing file does not
        // cost a reconnect. Other failures discard it conservatively.
        operation.reusable = result.is_ok() || result.as_ref().is_err_and(refused_by_server);
        if let Err(error) = &result {
            self.log_kind(format!("{error:#}"), LogKind::Error);
        }
        result
    }

    /// Whether a file stands at `path`. SIZE answers in one control-channel
    /// round trip, with 550 for a name that is free — or a folder, which a file
    /// cannot be renamed over anyway. A server that does not implement SIZE is
    /// asked for the parent's listing instead.
    async fn exists(&mut self, path: &str) -> BackendResult<bool> {
        let probe = path.to_string();
        let size = self
            .with_stream(move |s| Box::pin(async move {
                match s.size(&probe).await {
                    Ok(size) => Ok(Ok(size)),
                    Err(error @ suppaftp::FtpError::UnexpectedResponse(_)) => {
                        if matches!(&error, suppaftp::FtpError::UnexpectedResponse(response) if response.status == Status::NotAvailable) {
                            return Err(error.into());
                        }
                        Ok(Err(error))
                    }
                    Err(error) => Err(error.into()),
                }
            }))
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
            .read_listing(parent)
            .await?
            .0
            .iter()
            .any(|entry| entry.name == name))
    }

    /// Many servers answer a missing file and one they will not open with
    /// the same plain 550 ("Failed to open file"). Whether the parent lists
    /// the name tells the two apart.
    async fn explain_refusal(&mut self, path: &str, error: anyhow::Error) -> anyhow::Error {
        let unexplained = refused_by_server(&error)
            && crate::ipc::CommandError::from_anyhow(&error).code == ErrorCode::Internal;
        if !unexplained {
            return error;
        }
        let trimmed = path.trim_end_matches('/');
        let (parent, name) = trimmed.rsplit_once('/').unwrap_or(("", trimmed));
        let parent = if parent.is_empty() { "/" } else { parent };
        let (code, message) = match self.read_listing(parent).await {
            Ok((entries, _)) if entries.iter().any(|entry| entry.name == name) => {
                (ErrorCode::PermissionDenied, "The server refused access")
            }
            Ok(_) => (ErrorCode::NotFound, "File or folder not found"),
            Err(_) => return error,
        };
        error.context(crate::ipc::CommandError::new(code, message))
    }

    /// Whether `folder` can be entered, the working directory put back after.
    /// `None` when that could not be found out.
    async fn folder_opens(&self, folder: &str) -> Option<bool> {
        let folder = folder.to_owned();
        self.with_stream(move |s| {
            Box::pin(async move {
                let original = s.pwd().await.context("saving working directory")?;
                let opens = s.cwd(&folder).await.is_ok();
                s.cwd(&original)
                    .await
                    .context("restoring working directory")?;
                Ok(opens)
            })
        })
        .await
        .ok()
    }

    fn data_channel(&self) -> BackendResult<DataChannel> {
        self.data.clone().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })
    }

    /// A folder's entries. For a recursive operation (`resolve_links` off)
    /// a link stays a file and the folder itself must not be a link, so the
    /// walk cannot leave the tree it was started on.
    async fn list_entries(
        &mut self,
        path: &str,
        resolve_links: bool,
    ) -> BackendResult<Vec<EntryInfo>> {
        let target = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        if !resolve_links && !self.real_folders.remove(&target) {
            self.refuse_linked_folder(&target).await?;
        }
        let (mut entries, links) = match self.read_listing(&target).await {
            Ok(listing) => listing,
            Err(error) => return Err(self.explain_refusal(&target, error).await),
        };
        let basename = target
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        let suspicious = entries.is_empty() || (entries.len() == 1 && entries[0].name == basename);
        // Where a server lists what it could not open as nothing, or as the
        // name alone, entering the folder tells whether it is really there.
        if !self.mlsd
            && suspicious
            && target != "/"
            && self.folder_opens(&target).await == Some(false)
        {
            return Err(self
                .explain_refusal(
                    &target,
                    anyhow::Error::new(suppaftp::FtpError::UnexpectedResponse(
                        suppaftp::types::Response::new(
                            Status::FileUnavailable,
                            b"550 The folder cannot be opened".to_vec(),
                        ),
                    )),
                )
                .await);
        }
        if resolve_links && !links.is_empty() {
            let names = links
                .iter()
                .take(MAX_RESOLVED_LINKS)
                .map(|&index| entries[index].name.clone())
                .collect();
            let folders = self.linked_folders(&target, names).await;
            for (index, is_folder) in links.into_iter().zip(folders) {
                entries[index].is_directory = is_folder;
            }
        }
        if !resolve_links {
            // Each of these was listed as a folder, not a link, so the walk
            // entering it next needs no check of its own.
            if self.real_folders.len() > MAX_REAL_FOLDERS {
                self.real_folders.clear();
            }
            let parent = target.trim_end_matches('/');
            self.real_folders.extend(
                entries
                    .iter()
                    .filter(|entry| entry.is_directory)
                    .map(|entry| format!("{parent}/{}", entry.name)),
            );
        }
        self.log_key(
            "receivedEntries",
            serde_json::json!({ "count": entries.len() }),
            LogKind::Response,
        );
        Ok(entries)
    }

    /// Fails when `target` is a link in its parent's listing. A parent that
    /// cannot be listed leaves nothing to check against.
    async fn refuse_linked_folder(&mut self, target: &str) -> BackendResult<()> {
        let trimmed = target.trim_end_matches('/');
        let Some((parent, name)) = trimmed.rsplit_once('/') else {
            return Ok(());
        };
        if name.is_empty() {
            return Ok(());
        }
        let parent = if parent.is_empty() { "/" } else { parent };
        if let Ok((siblings, links)) = self.read_listing(parent).await {
            anyhow::ensure!(
                !links.iter().any(|&index| siblings[index].name == name),
                "Recursive operations cannot traverse an FTP symbolic link: {target}"
            );
        }
        Ok(())
    }

    /// The parsed listing of `target`, with the indexes of the entries that
    /// are links.
    async fn read_listing(&mut self, target: &str) -> BackendResult<(Vec<EntryInfo>, Vec<usize>)> {
        let target = target.to_owned();
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
        if raw_lines.len() > super::MAX_RAW_DIRECTORY_ENTRIES
            || raw_lines.iter().map(String::len).sum::<usize>() > super::MAX_DIRECTORY_TEXT_BYTES
        {
            anyhow::bail!(crate::ipc::CommandError::new(
                crate::ipc::ErrorCode::ResourceLimit,
                "FTP directory listing exceeds the configured limit",
            ));
        }
        let now = Utc::now();
        let mut entries = Vec::with_capacity(raw_lines.len());
        let mut links = Vec::new();
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
            if raw.is_symlink {
                links.push(entries.len());
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
        Ok((entries, links))
    }

    /// Which of the links in `folder` lead to a folder: LIST and MLSD only say
    /// that they are links. Entering one tells, and the working directory is
    /// put back afterwards. A link that cannot be entered counts as a file.
    async fn linked_folders(&self, folder: &str, names: Vec<String>) -> Vec<bool> {
        let count = names.len();
        let folder = folder.trim_end_matches('/').to_owned();
        self.with_stream(move |s| {
            Box::pin(async move {
                let original = s.pwd().await.context("saving working directory")?;
                let mut folders = Vec::with_capacity(names.len());
                for name in names {
                    folders.push(s.cwd(format!("{folder}/{name}")).await.is_ok());
                }
                s.cwd(&original)
                    .await
                    .context("restoring working directory")?;
                Ok(folders)
            })
        })
        .await
        .unwrap_or_else(|_| vec![false; count])
    }

    /// The lines of `target`'s listing, by MLSD where the server offers it.
    async fn fetch_listing(&self, target: &str) -> BackendResult<Vec<String>> {
        let command = if self.mlsd { "MLSD" } else { "LIST" };
        self.log_kind(format!("{command} {target}"), LogKind::Command);
        let target = target.to_owned();
        let data = self.data_channel()?;
        self.with_stream(move |s| {
            Box::pin(async move { Self::list_raw(s, &data, command, &target).await })
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
                let target = path.to_string();
                return match self
                    .with_stream(move |s| Box::pin(async move { Ok(s.rm(&target).await?) }))
                    .await
                {
                    Err(error) => Err(self.explain_refusal(path, error).await),
                    done => done,
                };
            }
            let entries = self.list_for_recursive(path).await?;
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
        let encoding = config.encoding;
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
            let peer = tcp.peer_addr()?.ip();
            let tickets = Arc::new(SessionTickets::new());
            let tls = if secure {
                // The relay secures the connection before the greeting.
                if encoding.is_some() {
                    this.log_key("tlsInit", serde_json::json!({}), LogKind::Status);
                }
                if allow_invalid_cert {
                    this.log_kind(
                        "WARNING: TLS certificate verification is disabled for this connection (allowInvalidCert) — the server's identity is not being checked.".to_string(),
                        LogKind::Error,
                    );
                }
                let mut tls_config =
                    Self::build_tls_config(allow_invalid_cert, ca_cert_path.as_deref())?;
                tls_config.resumption = rustls::client::Resumption::store(tickets.clone());
                let server_name = ServerName::try_from(host.clone())
                    .context("TLS handshake failed: invalid server name")?;
                Some((Arc::new(tls_config), server_name))
            } else {
                None
            };
            let connector = |(config, name): &(Arc<ClientConfig>, ServerName<'static>)| {
                (
                    tokio_rustls::TlsConnector::from(config.clone()),
                    name.clone(),
                )
            };
            let greeting = async {
                let tcp = match encoding {
                    Some(encoding) => {
                        super::ftp_charset::start(tcp, encoding, tls.as_ref().map(connector))
                            .await?
                    }
                    None => tcp,
                };
                Ok::<_, anyhow::Error>(AsyncRustlsFtpStream::connect_with_stream(tcp).await?)
            };
            tokio::pin!(greeting);
            let implicit = async {
                tokio::time::sleep(IMPLICIT_PROBE_AFTER).await;
                if !answers_tls(&host, port, proxy.as_ref()).await {
                    std::future::pending::<()>().await;
                }
            };
            let mut stream = tokio::select! {
                stream = &mut greeting => stream.context("FTP handshake failed")?,
                () = implicit => {
                    return Err(super::fail(
                        ErrorCode::TlsNegotiationFailed,
                        "The server expects implicit FTPS, which is not supported",
                    ));
                }
            };
            // The literal server welcome banner — a real, wire-level line,
            // same as FileZilla's own "Response: 220 ..." right after connect.
            if let Some(welcome) = stream.get_welcome_msg() {
                this.log_response_body(welcome.as_bytes());
            }
            if active_mode {
                stream.set_mode(suppaftp::types::Mode::Active);
            }
            let data = DataChannel {
                host: host.clone(),
                proxy: proxy.clone(),
                tls: tls.as_ref().map(connector),
                tickets,
                peer,
                encoding,
                active: active_mode,
                extended: Arc::new(AtomicBool::new(ipv6)),
            };
            if let Some((config, _)) = &tls {
                if encoding.is_some() {
                    // The relay already secured the connection; what is left
                    // of FTPS is protecting the data connections too.
                    for command in ["PBSZ 0", "PROT P"] {
                        this.logged_command(
                            &mut stream,
                            command.into(),
                            command,
                            &[Status::CommandOk],
                        )
                        .await
                        .context("TLS handshake failed")?;
                    }
                } else {
                    this.log_key("tlsInit", serde_json::json!({}), LogKind::Status);
                    let connector: AsyncRustlsConnector =
                        tokio_rustls::TlsConnector::from(config.clone()).into();
                    stream = stream
                        .into_secure(connector, &host)
                        .await
                        .context("TLS handshake failed")?;
                }
                this.log_key("tlsEstablished", serde_json::json!({}), LogKind::Response);
            }
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
            // A site with its own encoding names files in it, not in UTF-8.
            if encoding.is_none() {
                this.logged_best_effort(&mut stream, "OPTS UTF8 ON", &[Status::CommandOk])
                    .await;
            }

            stream
                .transfer_type(FtpFileType::Binary)
                .await
                .context("setting binary transfer type failed")?;
            Ok::<_, anyhow::Error>((stream, feat, data))
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
        let (stream, feat, data) = match outcome {
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
        self.data = Some(data);
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
        self.log_key(key, params, kind);
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
        self.log_kind(format!("MKD {path}"), LogKind::Command);
        let target = path.to_string();
        let made = self
            .with_stream(move |s| Box::pin(async move { Self::ensure_dir(s, &target).await }))
            .await;
        // An existing folder already counts as made, so a plain 550 left
        // over is the server refusing to create one.
        match made {
            Err(error)
                if refused_by_server(&error)
                    && crate::ipc::CommandError::from_anyhow(&error).code
                        == ErrorCode::Internal =>
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
        let path = path.to_string();
        let data = self.data_channel()?;
        self.with_stream(move |s| {
            Box::pin(async move {
                let stream = data.open(s, format!("STOR {path}"), STORE_OPEN).await?;
                UploadData(Some(stream)).finish(s).await
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

    /// RNTO replaces an existing file on most servers, but some refuse (IIS
    /// answers 550). That refusal is told apart from any other by both paths
    /// still standing, and the existing file is then set aside so the new one
    /// can take its name.
    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let (from, to) = (old_path.to_string(), new_path.to_string());
        // A refusal is the server's whole reply, so the connection stays in
        // step for the checks below instead of being thrown away.
        let refusal = self
            .with_stream(move |s| {
                Box::pin(async move {
                    match s.rename(&from, &to).await {
                        Ok(()) => Ok(None),
                        Err(error @ suppaftp::FtpError::UnexpectedResponse(_))
                            if !matches!(&error, suppaftp::FtpError::UnexpectedResponse(response) if response.status == Status::NotAvailable) =>
                        {
                            Ok(Some(error))
                        }
                        Err(error) => Err(error.into()),
                    }
                })
            })
            .await?;
        let Some(error) = refusal else {
            return Ok(());
        };
        self.log_kind(format!("{error}"), LogKind::Error);
        // SIZE answers only for a file, so a folder in the way stays an error.
        if self.exists(new_path).await? && self.exists(old_path).await? {
            return super::replace_by_setting_aside(self, old_path, new_path).await;
        }
        Err(error.into())
    }

    /// FTP has no conditional rename, and RNTO replaces an existing file on
    /// most servers. Looking at the target right before RNFR leaves only the
    /// moment between the two for a racing file to be replaced in, instead of
    /// the whole upload that staged it.
    async fn rename_no_replace(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        if self.exists(new_path).await? {
            return Err(super::fail(
                ErrorCode::AlreadyExists,
                format!("{new_path} already exists on the server; it was not replaced"),
            ));
        }
        self.rename(old_path, new_path).await
    }

    async fn size(&mut self, path: &str) -> u64 {
        self.known_size(path).await.unwrap_or(0)
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
            Box::pin(async move {
                match s.size(&path).await {
                    Ok(size) => Ok(Some(size as u64)),
                    Err(suppaftp::FtpError::UnexpectedResponse(response))
                        if response.status != Status::NotAvailable =>
                    {
                        Ok(None)
                    }
                    Err(error) => Err(error.into()),
                }
            })
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
                    match s.mdtm(&version_path).await {
                        Ok(date) => Ok(Some(date.to_string())),
                        Err(suppaftp::FtpError::UnexpectedResponse(response))
                            if response.status != Status::NotAvailable =>
                        {
                            Ok(None)
                        }
                        Err(error) => Err(error.into()),
                    }
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
        let data = self.data_channel()?;
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
                    let mut data_stream = data
                        .open(s, format!("RETR {remote_path_owned}"), RETRIEVE_OPEN)
                        .await?;
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
        let result = match result {
            Err(error) => Err(self.explain_refusal(remote_path, error).await),
            done => done,
        };

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
