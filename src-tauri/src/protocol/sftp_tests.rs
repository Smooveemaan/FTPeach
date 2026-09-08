use super::*;
// The backend takes only `KnownHostsStore`; these suites hand it the real
// `Store`, which is the implementation that has to keep working.
use crate::store::Store;

#[cfg(test)]
mod encoding_tests {
    use super::encode_hex;

    #[test]
    fn encodes_lowercase_hex_with_leading_zeroes() {
        assert_eq!(encode_hex(&[0x00, 0x09, 0xaf, 0xff]), "0009afff");
    }
}

#[cfg(test)]
mod path_guard_tests {
    use super::*;

    #[test]
    fn sftp_readdir_names_cannot_cross_a_path_boundary() {
        for name in ["..", ".", "../escape", r"..\escape", "/absolute", "a/b"] {
            assert!(
                !is_safe_path_segment(name),
                "unsafe SFTP name accepted: {name}"
            );
        }
        for name in ["..report.txt", "normal", "文件🙂.txt"] {
            assert!(
                is_safe_path_segment(name),
                "safe SFTP name rejected: {name}"
            );
        }
    }
}

#[cfg(test)]
mod local_integration_tests {
    use super::*;
    use russh::server::{Auth, Msg, Session};
    use russh::{Channel, ChannelId};
    use russh_sftp::protocol::{File, Handle, Name, Status, Version};
    use serde_json::json;
    use std::collections::HashMap;
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct TestSshSession {
        channels: Arc<AsyncMutex<HashMap<ChannelId, Channel<Msg>>>>,
    }

    impl russh::server::Handler for TestSshSession {
        type Error = anyhow::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            if user == "local" && password == "test" {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::reject())
            }
        }

        async fn channel_open_session(
            &mut self,
            channel: Channel<Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.channels.lock().await.insert(channel.id(), channel);
            reply.accept().await;
            Ok(())
        }

        async fn subsystem_request(
            &mut self,
            channel_id: ChannelId,
            name: &str,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            if name != "sftp" {
                session.channel_failure(channel_id)?;
                return Ok(());
            }
            let channel = self
                .channels
                .lock()
                .await
                .remove(&channel_id)
                .expect("opened SFTP channel");
            session.channel_success(channel_id)?;
            russh_sftp::server::run(channel.into_stream(), TestSftpSession::default()).await;
            Ok(())
        }
    }

    #[derive(Default)]
    struct TestSftpSession {
        listed: bool,
    }

    impl russh_sftp::server::Handler for TestSftpSession {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn init(
            &mut self,
            _version: u32,
            _extensions: HashMap<String, String>,
        ) -> Result<Version, Self::Error> {
            Ok(Version::new())
        }

        async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, Self::Error> {
            Ok(Name {
                id,
                files: vec![File::dummy("/")],
            })
        }

        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
            self.listed = false;
            Ok(Handle { id, handle: path })
        }

        async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
            if handle == "/" && !self.listed {
                self.listed = true;
                let attrs = FileAttributes {
                    size: Some(5),
                    ..Default::default()
                };
                return Ok(Name {
                    id,
                    files: vec![File::new("hello.txt", attrs)],
                });
            }
            Err(StatusCode::Eof)
        }

        async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: "Ok".to_string(),
                language_tag: "en-US".to_string(),
            })
        }
    }

    fn random_host_key() -> russh::keys::PrivateKey {
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap()
    }

    async fn spawn_sftp_server() -> (
        u16,
        Arc<StdMutex<russh::keys::PrivateKey>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let key = Arc::new(StdMutex::new(random_host_key()));
        let server_key = key.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let config = russh::server::Config {
                    auth_rejection_time: Duration::ZERO,
                    auth_rejection_time_initial: Some(Duration::ZERO),
                    keys: vec![server_key.lock().unwrap().clone()],
                    ..Default::default()
                };
                tokio::spawn(async move {
                    if let Ok(running) = russh::server::run_stream(
                        Arc::new(config),
                        socket,
                        TestSshSession::default(),
                    )
                    .await
                    {
                        let _ = running.await;
                    }
                });
            }
        });
        (port, key, handle)
    }

    #[tokio::test]
    async fn local_server_pins_reuses_and_rejects_changed_host_key() {
        let (port, server_key, server) = spawn_sftp_server().await;
        let store_dir = std::env::temp_dir().join(format!("ftpeach-sftp-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(store_dir.clone());
        let map = json!({
            "protocol": "sftp",
            "host": "127.0.0.1",
            "port": port,
            "user": "local",
            "password": "test"
        })
        .as_object()
        .unwrap()
        .clone();
        let config = crate::protocol::config::ConnectionConfig::from_json_map(&map).unwrap();
        let mut backend = SftpBackend::new(Arc::new(store.clone()));

        backend.connect(&config).await.unwrap();
        assert!(backend.is_connected());
        let entries = backend.list("/").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "hello.txt");
        assert_eq!(entries[0].size, 5);
        backend.disconnect().await.unwrap();

        backend.connect(&config).await.unwrap();
        assert!(backend.is_connected());
        backend.disconnect().await.unwrap();

        *server_key.lock().unwrap() = random_host_key();
        let error = backend.connect(&config).await.unwrap_err();
        assert!(error.downcast_ref::<HostKeyMismatchError>().is_some());
        assert!(!backend.is_connected());

        tokio::fs::remove_dir_all(&store_dir).await.unwrap();
        server.abort();
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn connects_lists_and_downloads_from_rebex_sftp() {
        let body = async {
            let store = Store::new_at(
                std::env::temp_dir()
                    .join(format!("ftpeach-sftp-live-test-{}", uuid::Uuid::new_v4())),
            );
            let mut backend = SftpBackend::new(Arc::new(store));
            let config = json!({
                "host": "test.rebex.net",
                "port": 22,
                "user": "demo",
                "password": "password",
            })
            .as_object()
            .unwrap()
            .clone();
            let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();

            backend
                .connect(&config)
                .await
                .expect("connect should succeed");
            assert!(backend.is_connected());

            let entries = backend.list("/").await.expect("list should succeed");
            assert!(!entries.is_empty(), "rebex demo root should have entries");
            let readme = entries
                .iter()
                .find(|e| e.name.eq_ignore_ascii_case("readme.txt"));
            assert!(
                readme.is_some(),
                "expected readme.txt in rebex demo root, got: {:?}",
                entries.iter().map(|e| &e.name).collect::<Vec<_>>()
            );

            let tmp = std::env::temp_dir().join("ftpeach-live-test-sftp-readme.txt");
            let _ = tokio::fs::remove_file(&tmp).await;
            let progress: ProgressSink = Arc::new(|_info| {});
            backend
                .download("/readme.txt", &tmp, false, progress)
                .await
                .expect("download should succeed");
            let downloaded = tokio::fs::read(&tmp)
                .await
                .expect("downloaded file should exist");
            assert!(
                !downloaded.is_empty(),
                "downloaded readme.txt should not be empty"
            );
            let _ = tokio::fs::remove_file(&tmp).await;

            backend
                .disconnect()
                .await
                .expect("disconnect should succeed");
            assert!(!backend.is_connected());
        };
        tokio::time::timeout(Duration::from_secs(30), body)
            .await
            .expect("live test timed out after 30s");
    }
}

#[cfg(test)]
mod tofu_tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};
    use russh::server::{Auth, Server as _};
    use std::net::SocketAddr;

    #[derive(Clone)]
    struct TestServer;

    impl russh::server::Server for TestServer {
        type Handler = TestSession;
        fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
            TestSession
        }
    }

    struct TestSession;

    impl russh::server::Handler for TestSession {
        type Error = anyhow::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> anyhow::Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }
    }

    fn random_host_key() -> PrivateKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
    }

    async fn spawn_server(host_key: PrivateKey) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Arc::new(russh::server::Config {
            auth_rejection_time: Duration::from_millis(50),
            auth_rejection_time_initial: Some(Duration::ZERO),
            keys: vec![host_key],
            ..Default::default()
        });
        let mut server = TestServer;
        let handle = tokio::spawn(async move {
            let _ = server.run_on_socket(config, &listener).await;
        });
        (port, handle)
    }

    fn test_store() -> Store {
        let dir =
            std::env::temp_dir().join(format!("ftpeach-sftp-tofu-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::new_at(dir)
    }

    enum Outcome {
        Connected,
        Rejected(HostKeyMismatchError),
    }

    async fn try_connect(store: &Store, port: u16) -> Outcome {
        let mismatch = Arc::new(StdMutex::new(None));
        let handler = TofuHandler {
            known_hosts: Arc::new(store.clone()),
            host: "127.0.0.1".to_string(),
            port,
            mismatch: mismatch.clone(),
        };
        let config = Arc::new(client::Config::default());
        match client::connect(config, ("127.0.0.1", port), handler).await {
            Ok(mut session) => {
                let auth = session
                    .authenticate_password("spike", "spike")
                    .await
                    .unwrap();
                assert!(auth.success());
                let _ = session
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                Outcome::Connected
            }
            Err(_) => Outcome::Rejected(
                mismatch
                    .lock()
                    .unwrap()
                    .take()
                    .expect("connect failed with no recorded mismatch"),
            ),
        }
    }

    #[tokio::test]
    async fn tofu_pins_matches_and_fails_closed_on_mismatch() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let store = test_store();

        let key_a = random_host_key();
        let (port_a, server_a) = spawn_server(key_a).await;
        assert!(
            matches!(try_connect(&store, port_a).await, Outcome::Connected),
            "first sighting should pin and accept"
        );

        assert!(
            matches!(try_connect(&store, port_a).await, Outcome::Connected),
            "repeat connection should match pinned key"
        );
        server_a.abort();

        let key_b = random_host_key();
        let (port_b, server_b) = spawn_server(key_b).await;
        let pinned = store
            .get_known_host_fingerprint("127.0.0.1", port_a)
            .await
            .unwrap();
        store
            .set_known_host_fingerprint("127.0.0.1", port_b, &pinned)
            .await
            .unwrap();
        match try_connect(&store, port_b).await {
            Outcome::Rejected(m) => assert_ne!(
                m.expected, m.actual,
                "mismatch must report two different fingerprints"
            ),
            Outcome::Connected => panic!("a changed host key must never be silently accepted"),
        }
        server_b.abort();

        let still_pinned = store
            .get_known_host_fingerprint("127.0.0.1", port_b)
            .await
            .unwrap();
        assert_eq!(
            still_pinned, pinned,
            "a rejected mismatch must never be auto-persisted"
        );
    }
}
