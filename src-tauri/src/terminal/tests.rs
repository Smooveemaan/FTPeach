use super::*;
use crate::domain::{Protocol, ServerSettings, WindowConnectionSettings};
use crate::protocol::ProtocolBackend;
use crate::protocol::config::ConnectionConfig;
use crate::protocol::sftp::SftpBackend;
use crate::runtime::log_emitter::LogEmitter;
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Sessions};
use crate::store::Store;
use base64::Engine;
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol as sftp_proto;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, mpsc};

type RecordedPtyModes = Arc<StdMutex<Vec<Vec<(russh::Pty, u32)>>>>;

#[derive(Clone, Default)]
struct PtyServerOpts {
    refuse_shell: bool,
    flood_bytes: usize,
    resizes: Arc<StdMutex<Vec<(u32, u32)>>>,
    pty_terms: Arc<StdMutex<Vec<(String, u32, u32)>>>,
    pty_modes: RecordedPtyModes,
}

struct PtyTestHandler {
    opts: PtyServerOpts,
    open_channels: Arc<AsyncMutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl PtyTestHandler {
    async fn take_channel(&self, id: ChannelId) -> Channel<Msg> {
        self.open_channels
            .lock()
            .await
            .remove(&id)
            .expect("channel opened prior to request")
    }
}

impl russh::server::Handler for PtyTestHandler {
    type Error = anyhow::Error;

    async fn auth_password(&mut self, user: &str, pass: &str) -> Result<Auth, Self::Error> {
        Ok(match (user, pass) {
            ("local", "test") => Auth::Accept,
            _ => Auth::reject(),
        })
    }

    async fn channel_open_session(
        &mut self,
        ch: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _sess: &mut Session,
    ) -> Result<(), Self::Error> {
        self.open_channels.lock().await.insert(ch.id(), ch);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        id: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _pw: u32,
        _ph: u32,
        modes: &[(russh::Pty, u32)],
        sess: &mut Session,
    ) -> Result<(), Self::Error> {
        self.opts
            .pty_terms
            .lock()
            .unwrap()
            .push((term.to_owned(), cols, rows));
        self.opts.pty_modes.lock().unwrap().push(modes.to_vec());
        sess.channel_success(id)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        id: ChannelId,
        sess: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.opts.refuse_shell {
            sess.channel_failure(id)?;
            return Ok(());
        }
        let ch = self.take_channel(id).await;
        sess.channel_success(id)?;
        let flood = self.opts.flood_bytes;
        tokio::spawn(async move {
            if flood > 0 {
                let buf = vec![b'A'; flood];
                for part in buf.chunks(16 * 1024) {
                    if ch.data(part).await.is_err() {
                        return;
                    }
                }
                let _ = ch.exit_status(0).await;
                let _ = ch.eof().await;
                let _ = ch.close().await;
                return;
            }
            let _ = ch.data(&b"ready\r\n"[..]).await;
            let mut ch = ch;
            while let Some(msg) = ch.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } if data.as_ref() == b"exit42\n" => {
                        let _ = ch.exit_status(42).await;
                        let _ = ch.eof().await;
                        let _ = ch.close().await;
                        break;
                    }
                    russh::ChannelMsg::Data { data } => {
                        if ch.data(data.as_ref()).await.is_err() {
                            break;
                        }
                    }
                    russh::ChannelMsg::Close | russh::ChannelMsg::Eof => break,
                    _ => {}
                }
            }
        });
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _id: ChannelId,
        cols: u32,
        rows: u32,
        _pw: u32,
        _ph: u32,
        _sess: &mut Session,
    ) -> Result<(), Self::Error> {
        self.opts.resizes.lock().unwrap().push((cols, rows));
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        sess: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            sess.channel_failure(id)?;
            return Ok(());
        }
        let ch = self.take_channel(id).await;
        sess.channel_success(id)?;
        tokio::spawn(async move {
            russh_sftp::server::run(ch.into_stream(), StubSftp(false)).await;
        });
        Ok(())
    }
}

struct StubSftp(bool);

impl russh_sftp::server::Handler for StubSftp {
    type Error = sftp_proto::StatusCode;

    fn unimplemented(&self) -> Self::Error {
        sftp_proto::StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _ver: u32,
        _ext: HashMap<String, String>,
    ) -> Result<sftp_proto::Version, Self::Error> {
        Ok(sftp_proto::Version::new())
    }

    async fn opendir(
        &mut self,
        id: u32,
        handle: String,
    ) -> Result<sftp_proto::Handle, Self::Error> {
        self.0 = false;
        Ok(sftp_proto::Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<sftp_proto::Name, Self::Error> {
        if handle == "/" && !self.0 {
            self.0 = true;
            let file = sftp_proto::File::new("hello.txt", sftp_proto::FileAttributes::default());
            return Ok(sftp_proto::Name {
                id,
                files: vec![file],
            });
        }
        Err(sftp_proto::StatusCode::Eof)
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<sftp_proto::Status, Self::Error> {
        Ok(sftp_proto::Status {
            id,
            status_code: sftp_proto::StatusCode::Ok,
            error_message: String::from("Ok"),
            language_tag: String::from("en-US"),
        })
    }
}

async fn spawn_ssh_server(opts: PtyServerOpts) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let handle = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let cfg = Arc::new(russh::server::Config {
                auth_rejection_time: Duration::ZERO,
                keys: vec![key.clone()],
                ..Default::default()
            });
            let handler = PtyTestHandler {
                opts: opts.clone(),
                open_channels: Arc::new(AsyncMutex::new(HashMap::new())),
            };
            tokio::spawn(async move {
                let _ = russh::server::run_stream(cfg, socket, handler).await;
            });
        }
    });
    (port, handle)
}

async fn connect_test_sftp(
    opts: PtyServerOpts,
    tag: &str,
) -> (SftpBackend, PathBuf, tokio::task::JoinHandle<()>) {
    let (port, server) = spawn_ssh_server(opts).await;
    let dir = std::env::temp_dir().join(format!("ftpeach-term-{tag}-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(Store::new_at(dir.clone()));
    let config = ConnectionConfig::for_test(
        serde_json::json!({
            "protocol": "sftp",
            "host": "127.0.0.1",
            "port": port,
            "user": "local",
            "password": "test",
            "strictHostKeyCheck": false
        })
        .as_object()
        .unwrap(),
    )
    .unwrap();
    let mut backend = SftpBackend::new(store);
    backend.connect(&config).await.unwrap();
    (backend, dir, server)
}

fn event_sink() -> (TerminalEventSink, mpsc::UnboundedReceiver<TerminalEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let sink: TerminalEventSink = Arc::new(move |event| tx.send(event).map_err(|e| e.to_string()));
    (sink, rx)
}

async fn recv_event(rx: &mut mpsc::UnboundedReceiver<TerminalEvent>) -> TerminalEvent {
    tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

fn decode_output(event: &TerminalEvent) -> Option<Vec<u8>> {
    match event {
        TerminalEvent::Output { data, bytes } => {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap();
            assert_eq!(decoded.len(), *bytes);
            Some(decoded)
        }
        _ => None,
    }
}

async fn open_terminal_id(
    terminals: &Terminals,
    conn_id: &str,
    ssh: Arc<dyn SshSessionHandle>,
) -> (String, mpsc::UnboundedReceiver<TerminalEvent>) {
    let (sink, rx) = event_sink();
    let TerminalOpenOutcome::Opened { terminal_id } =
        terminals.open(conn_id, ssh, 80, 24, sink).await.unwrap()
    else {
        panic!("expected opened terminal");
    };
    (terminal_id, rx)
}

#[tokio::test]
async fn sftp_and_pty_multiplex_on_one_ssh_session_with_resize_and_exit() {
    let opts = PtyServerOpts::default();
    let (mut backend, dir, server) = connect_test_sftp(opts.clone(), "mux").await;
    let ssh = backend.ssh_handle().expect("SFTP exposes SSH handle");

    let terminals = Terminals::default();
    let (terminal_id, mut rx) = open_terminal_id(&terminals, "conn-1", ssh).await;

    let bytes = decode_output(&recv_event(&mut rx).await).unwrap();
    assert_eq!(bytes, b"ready\r\n");
    terminals.ack(&terminal_id, bytes.len()).unwrap();

    // Concurrent SFTP listing works on the same SSH transport while terminal is open.
    let entries = backend.list("/").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "hello.txt");

    // Input (including multibyte UTF-8 across scripts) echoes back intact and resize reaches the server.
    let utf8_sample = "ping-\u{043f}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442}-\u{4f60}\u{597d}";
    terminals
        .write(&terminal_id, utf8_sample.as_bytes().to_vec())
        .await
        .unwrap();
    assert_eq!(
        decode_output(&recv_event(&mut rx).await).unwrap(),
        utf8_sample.as_bytes()
    );

    terminals.resize(&terminal_id, 132, 40).await.unwrap();
    terminals
        .write(&terminal_id, b"exit42\n".to_vec())
        .await
        .unwrap();
    assert_eq!(
        recv_event(&mut rx).await,
        TerminalEvent::Exit { code: Some(42) }
    );

    assert_eq!(
        *opts.pty_terms.lock().unwrap(),
        vec![("xterm-256color".to_owned(), 80, 24)]
    );
    assert_eq!(
        *opts.pty_modes.lock().unwrap(),
        vec![vec![(russh::Pty::IUTF8, 1)]]
    );
    assert_eq!(*opts.resizes.lock().unwrap(), vec![(132, 40)]);

    backend.disconnect().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn backpressure_pauses_output_at_credit_window_and_resumes_after_ack() {
    let total_bytes = MAX_IN_FLIGHT_BYTES * 2;
    let opts = PtyServerOpts {
        flood_bytes: total_bytes,
        ..Default::default()
    };
    let (mut backend, dir, server) = connect_test_sftp(opts, "bp").await;
    let ssh = backend.ssh_handle().unwrap();

    let terminals = Terminals::default();
    let (terminal_id, mut rx) = open_terminal_id(&terminals, "conn-bp", ssh).await;

    let mut paused_bytes = 0usize;
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
        if let Some(chunk) = decode_output(&event) {
            paused_bytes += chunk.len();
        }
    }
    assert!(
        paused_bytes >= MAX_IN_FLIGHT_BYTES && paused_bytes < total_bytes,
        "expected pause between {MAX_IN_FLIGHT_BYTES} and {total_bytes}, got {paused_bytes}"
    );

    terminals.ack(&terminal_id, paused_bytes).unwrap();
    let mut received = paused_bytes;
    let mut exited = false;
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
        match event {
            TerminalEvent::Output { bytes, .. } => {
                received += bytes;
                terminals.ack(&terminal_id, bytes).unwrap();
            }
            TerminalEvent::Exit { code } => {
                assert_eq!(code, Some(0));
                exited = true;
                break;
            }
            TerminalEvent::Closed { .. } => break,
        }
    }
    assert!(exited);
    assert_eq!(received, total_bytes);

    backend.disconnect().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn shell_refusal_reports_structured_outcome_without_breaking_sftp() {
    let opts = PtyServerOpts {
        refuse_shell: true,
        ..Default::default()
    };
    let (mut backend, dir, server) = connect_test_sftp(opts, "refuse").await;
    let ssh = backend.ssh_handle().unwrap();

    let terminals = Terminals::default();
    let (sink, _rx) = event_sink();
    let outcome = terminals
        .open("conn-sftp-only", ssh, 80, 24, sink)
        .await
        .unwrap();
    assert!(matches!(outcome, TerminalOpenOutcome::ShellRefused { .. }));
    assert_eq!(terminals.active_count(), 0);

    let entries = backend.list("/").await.unwrap();
    assert_eq!(entries.len(), 1);

    backend.disconnect().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn disconnect_closes_terminals_and_io_never_reaches_log_emitter() {
    let (port, server) = spawn_ssh_server(PtyServerOpts::default()).await;
    let dir = std::env::temp_dir().join(format!("ftpeach-term-disc-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    store
        .set_settings(
            serde_json::json!({ "strictHostKeyCheck": false })
                .as_object()
                .unwrap()
                .clone(),
        )
        .await
        .unwrap();
    let vault = Vault::new(dir.join("vault"));
    let sessions = Sessions::default();
    let connecting = ConnectingClients::default();
    let terminals = Terminals::default();
    let log_emitter = LogEmitter::start(dir.join("logs"), |_| {});

    let server_settings = ServerSettings {
        protocol: Protocol::Sftp,
        host: "127.0.0.1".into(),
        port: Some(port),
        webdav_url: String::new(),
        user: "local".into(),
        remote_path: "/".into(),
        allow_invalid_cert: false,
        allow_cleartext_auth: false,
        ca_cert_path: String::new(),
        use_key_auth: false,
        key_path: String::new(),
        open_terminal_on_connect: false,
        encoding: String::new(),
        max_connections: None,
    };
    let creds = crate::domain::Credentials {
        password: crate::security::sensitive_string::SensitiveString::from("test"),
        key_passphrase: None,
    };
    let window = WindowConnectionSettings {
        timeout_ms: 5_000,
        active_mode: false,
    };

    crate::application::session_service::connect(
        &sessions,
        &connecting,
        &terminals,
        &log_emitter,
        &store,
        &vault,
        "conn-live",
        &server_settings,
        creds,
        window,
    )
    .await
    .unwrap_or_else(|e| panic!("connect failed: {}", e.error.message));

    let ssh = sessions.ssh_handle_for("conn-live").unwrap();
    let (terminal_id, mut rx) = open_terminal_id(&terminals, "conn-live", ssh).await;
    let _ = recv_event(&mut rx).await;

    let secret_marker = "SUDO_SECRET_NEVER_LOG_12345";
    terminals
        .write(&terminal_id, secret_marker.as_bytes().to_vec())
        .await
        .unwrap();
    assert_eq!(
        decode_output(&recv_event(&mut rx).await).unwrap(),
        secret_marker.as_bytes()
    );

    crate::application::session_service::disconnect(
        &sessions,
        &connecting,
        &terminals,
        "conn-live",
    )
    .await;
    assert!(matches!(
        recv_event(&mut rx).await,
        TerminalEvent::Closed { .. }
    ));
    assert_eq!(terminals.active_count(), 0);
    assert!(sessions.ssh_handle_for("conn-live").is_none());

    for entry in log_emitter.recent() {
        let serialized = serde_json::to_string(&entry).unwrap();
        assert!(
            !serialized.contains(secret_marker) && !serialized.contains("ready"),
            "terminal I/O leaked into log: {serialized}"
        );
    }

    server.abort();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn dimensions_and_write_limits_are_enforced() {
    assert!(validate_dimensions(1, 24).is_err());
    assert!(validate_dimensions(501, 24).is_err());
    assert!(validate_dimensions(80, 0).is_err());
    assert!(validate_dimensions(80, 201).is_err());
    assert!(validate_dimensions(80, 24).is_ok());

    let terminals = Terminals::default();
    let oversized = vec![b'x'; MAX_WRITE_BYTES + 1];
    let error = terminals.write("missing", oversized).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
}
