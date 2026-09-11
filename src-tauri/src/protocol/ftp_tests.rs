use super::*;

#[tokio::test]
async fn list_reader_rejects_stalls_and_enforces_budgets_before_eof() {
    let (mut writer, mut reader) = tokio::io::duplex(32);
    writer.write_all(b"partial filename").await.unwrap();
    let error = read_list_data(&mut reader, Duration::from_millis(10))
        .await
        .unwrap_err();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&error).code,
        ErrorCode::TimedOut
    );
    for data in [
        vec![b'x'; super::super::MAX_DIRECTORY_TEXT_BYTES + 1],
        vec![b'\n'; super::super::MAX_DIRECTORY_ENTRIES + 1],
    ] {
        let mut reader = std::io::Cursor::new(data);
        let error = read_list_data(&mut reader, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            ErrorCode::ResourceLimit
        );
    }
}

#[cfg(test)]
mod path_guard_tests {
    use super::*;

    #[test]
    fn parsed_ftp_list_names_cannot_cross_a_path_boundary() {
        let now = Utc::now();
        for name in ["..", ".", "../escape", r"..\escape", "folder/file"] {
            let line = format!("-rw-r--r-- 1 owner group 1 Nov 5 2018 {name}");
            let raw = list_parse::parse_line(&line, now).unwrap();
            assert!(
                !is_safe_path_segment(&raw.name),
                "unsafe FTP name accepted: {name}"
            );
        }
        let raw = list_parse::parse_line("-rw-r--r-- 1 owner group 1 Nov 5 2018 ..report.txt", now)
            .unwrap();
        assert!(is_safe_path_segment(&raw.name));
    }
}

#[cfg(test)]
mod local_integration_tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

    const TEST_CERT_DER: &str = "MIIBszCCAVmgAwIBAgIUUg3keFcU1xXWK8BNVb1KynPulV8wCgYIKoZIzj0EAwIwJjEkMCIGA1UEAwwbUnVzdGxzIFJvYnVzdCBSb290IC0gUnVuZyAyMCAXDTc1MDEwMTAwMDAwMFoYDzQwOTYwMTAxMDAwMDAwWjAhMR8wHQYDVQQDDBZyY2dlbiBzZWxmIHNpZ25lZCBjZXJ0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEud6w4gtZ0xbwJ3E69SSMy5TZfdIifl9L5ZY+hgEe4UiUsBWS32f6Y5NR5Jo8FO1f6o13b3+FvVHREHCGdvppL6NoMGYwFQYDVR0RBA4wDIIKZm9vYmFyLmNvbTAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwHQYDVR0OBBYEFELvxbj5tD75n4pYFvJyr+c8qVEiMA8GA1UdEwEB/wQFMAMBAQAwCgYIKoZIzj0EAwIDSAAwRQIhALxSSdUsrRFnwNMu/doBqI8i8u5HdohVAheFTDwObkOMAiASSjULUtkWSD15u/7Sr01Wm9J1MpqW1pobBVqU3CNRlA==";
    const TEST_KEY_DER: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTbAQpfjAT46fgF4BmP15n37woNG5ZNJmwcqsred/7tmhRANCAAS53rDiC1nTFvAncTr1JIzLlNl90iJ+X0vllj6GAR7hSJSwFZLfZ/pjk1HkmjwU7V/qjXdvf4W9UdEQcIZ2+mkv";

    async fn serve_tls_commands<S>(stream: S)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let (reader, mut writer) = tokio::io::split(stream);
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let command = line.split_whitespace().next().unwrap_or_default();
            let response: &[u8] = match command.to_ascii_uppercase().as_str() {
                "PBSZ" | "PROT" | "OPTS" | "TYPE" | "NOOP" => b"200 OK\r\n",
                "USER" => b"331 Password required\r\n",
                "PASS" => b"230 Logged in\r\n",
                "SYST" => b"215 UNIX Type: L8\r\n",
                "FEAT" => b"211-Features\r\n UTF8\r\n211 End\r\n",
                "QUIT" => {
                    writer.write_all(b"221 Goodbye\r\n").await.unwrap();
                    return;
                }
                other => panic!("unexpected FTPS command: {other}"),
            };
            writer.write_all(response).await.unwrap();
        }
    }

    async fn spawn_ftps_server() -> (u16, tokio::task::JoinHandle<()>) {
        let decode = |value| {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .unwrap()
        };
        spawn_ftps_server_with_cert(decode(TEST_CERT_DER), decode(TEST_KEY_DER)).await
    }

    async fn spawn_ftps_server_with_cert(
        cert_der: Vec<u8>,
        key_der: Vec<u8>,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        let cert = rustls_pki_types::CertificateDer::from(cert_der);
        let key = rustls_pki_types::PrivateKeyDer::Pkcs8(
            rustls_pki_types::PrivatePkcs8KeyDer::from(key_der),
        );
        let tls = rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS12])
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    socket
                        .write_all(b"220 FTPeach local FTPS server\r\n")
                        .await
                        .unwrap();
                    let mut auth = String::new();
                    {
                        let mut reader = BufReader::new(&mut socket);
                        reader.read_line(&mut auth).await.unwrap();
                    }
                    assert_eq!(auth.trim_end(), "AUTH TLS");
                    socket.write_all(b"234 Start TLS\r\n").await.unwrap();
                    if let Ok(tls_stream) = acceptor.accept(socket).await {
                        serve_tls_commands(tls_stream).await;
                    }
                });
            }
        });
        (port, handle)
    }

    /// What the local test server holds: file paths, each five bytes long.
    #[derive(Clone)]
    struct TestServer {
        files: Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
        /// Off, SIZE is refused the way servers without RFC 3659 refuse it.
        size_supported: bool,
    }

    impl TestServer {
        fn holding(paths: &[&str], size_supported: bool) -> Self {
            let files = paths.iter().map(|path| path.to_string()).collect();
            Self {
                files: Arc::new(std::sync::Mutex::new(files)),
                size_supported,
            }
        }

        fn has(&self, path: &str) -> bool {
            self.files.lock().unwrap().contains(path)
        }

        fn paths(&self) -> Vec<String> {
            self.files.lock().unwrap().iter().cloned().collect()
        }

        fn listing(&self, dir: &str) -> String {
            let prefix = format!("{}/", dir.trim_end_matches('/'));
            self.files
                .lock()
                .unwrap()
                .iter()
                .filter_map(|path| path.strip_prefix(&prefix))
                .filter(|name| !name.contains('/'))
                .map(|name| format!("-rw-r--r-- 1 owner group 5 Nov 05 2018 {name}\r\n"))
                .collect()
        }

        fn rename(&self, from: &str, to: &str) {
            let mut files = self.files.lock().unwrap();
            files.remove(from);
            files.insert(to.to_owned());
        }
    }

    fn local_config(port: u16) -> crate::protocol::config::ConnectionConfig {
        let config = json!({
            "protocol": "ftp",
            "host": "127.0.0.1",
            "port": port,
            "user": "local",
            "password": "test"
        })
        .as_object()
        .unwrap()
        .clone();
        crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap()
    }

    async fn serve_control(socket: TcpStream, server: TestServer) {
        let (reader, mut writer) = socket.into_split();
        let mut lines = BufReader::new(reader).lines();
        let mut passive_listener: Option<TcpListener> = None;
        let mut renaming: Option<String> = None;
        writer
            .write_all(b"220 FTPeach local test server\r\n")
            .await
            .unwrap();

        while let Ok(Some(line)) = lines.next_line().await {
            let (command, argument) = line
                .split_once(' ')
                .map_or((line.as_str(), ""), |(command, argument)| {
                    (command, argument)
                });
            match command.to_ascii_uppercase().as_str() {
                "OPTS" if server.has("/reject-opts") => {
                    writer.write_all(b"504 Unknown command\r\n").await.unwrap()
                }
                "OPTS" if server.has("/close-opts") => {
                    writer
                        .write_all(b"421 Service unavailable\r\n")
                        .await
                        .unwrap();
                    return;
                }
                "OPTS" => writer.write_all(b"200 UTF8 enabled\r\n").await.unwrap(),
                "USER" => writer
                    .write_all(b"331 Password required\r\n")
                    .await
                    .unwrap(),
                "PASS" => writer.write_all(b"230 Logged in\r\n").await.unwrap(),
                "SYST" => writer.write_all(b"215 UNIX Type: L8\r\n").await.unwrap(),
                "FEAT" => writer
                    .write_all(b"211-Features\r\n UTF8\r\n EPSV\r\n211 End\r\n")
                    .await
                    .unwrap(),
                "TYPE" => writer.write_all(b"200 Type set\r\n").await.unwrap(),
                "EPSV" => {
                    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let port = listener.local_addr().unwrap().port();
                    passive_listener = Some(listener);
                    writer
                        .write_all(
                            format!("229 Entering Extended Passive Mode (|||{port}|)\r\n")
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                "PASV" => {
                    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let port = listener.local_addr().unwrap().port();
                    passive_listener = Some(listener);
                    writer
                        .write_all(
                            format!(
                                "227 Entering Passive Mode (127,0,0,1,{},{})\r\n",
                                port / 256,
                                port % 256
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                "LIST" => {
                    let listing = server.listing(if argument.is_empty() { "/" } else { argument });
                    writer
                        .write_all(b"150 Opening data connection\r\n")
                        .await
                        .unwrap();
                    let listener = passive_listener.take().expect("PASV/EPSV before LIST");
                    let (mut data, _) = listener.accept().await.unwrap();
                    data.write_all(listing.as_bytes()).await.unwrap();
                    data.shutdown().await.unwrap();
                    writer
                        .write_all(b"226 Transfer complete\r\n")
                        .await
                        .unwrap();
                }
                "SIZE" => {
                    if argument == "/drop-size" {
                        return;
                    }
                    let reply: &[u8] = if !server.size_supported {
                        b"502 Command not implemented\r\n"
                    } else if server.has(argument) {
                        b"213 5\r\n"
                    } else {
                        b"550 No such file\r\n"
                    };
                    writer.write_all(reply).await.unwrap();
                }
                "MDTM" => writer.write_all(b"213 20260911000000\r\n").await.unwrap(),
                "RETR" => {
                    writer
                        .write_all(b"150 Opening data connection\r\n")
                        .await
                        .unwrap();
                    let (mut data, _) = passive_listener.take().unwrap().accept().await.unwrap();
                    data.write_all(b"hello").await.unwrap();
                    if argument == "/extra" {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        let _ = data.write_all(b"!").await;
                    }
                    let _ = data.shutdown().await;
                    let _ = writer.write_all(b"226 Transfer complete\r\n").await;
                }
                "RNFR" => {
                    renaming = Some(argument.to_owned());
                    writer.write_all(b"350 Ready for RNTO\r\n").await.unwrap();
                }
                "RNTO" => {
                    // Like most servers, a rename replaces whatever stood there.
                    server.rename(&renaming.take().expect("RNFR before RNTO"), argument);
                    writer.write_all(b"250 Renamed\r\n").await.unwrap();
                }
                "QUIT" => {
                    writer.write_all(b"221 Goodbye\r\n").await.unwrap();
                    return;
                }
                "NOOP" => {
                    let reply: &[u8] = if server.has("/reject-noop") {
                        b"421 Service unavailable\r\n"
                    } else {
                        b"200 Still here\r\n"
                    };
                    writer.write_all(reply).await.unwrap();
                }
                other => panic!("unexpected FTP command: {other} {argument}"),
            }
        }
    }

    async fn spawn_ftp_server(server: TestServer) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(serve_control(socket, server.clone()));
            }
        });
        (port, handle)
    }

    #[tokio::test]
    async fn optional_utf8_refusal_is_a_response_but_service_loss_is_an_error() {
        for (marker, succeeds) in [("/reject-opts", true), ("/close-opts", false)] {
            let (port, server) = spawn_ftp_server(TestServer::holding(&[marker], true)).await;
            let mut backend = FtpBackend::new();
            let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured = logs.clone();
            backend.set_log_sink(Some(Arc::new(move |text, kind| {
                captured.lock().unwrap().push((text, kind));
            })));
            assert_eq!(backend.connect(&local_config(port)).await.is_ok(), succeeds);
            {
                let logs = logs.lock().unwrap();
                let raw: Vec<_> = logs
                    .iter()
                    .filter_map(|(text, kind)| match text {
                        LogText::Raw(text) => Some((text.as_str(), kind)),
                        _ => None,
                    })
                    .collect();
                assert_eq!(
                    raw.iter()
                        .filter(|(text, _)| *text == "OPTS UTF8 ON")
                        .count(),
                    1
                );
                let opts = raw
                    .iter()
                    .position(|(text, _)| *text == "OPTS UTF8 ON")
                    .unwrap();
                let pass = raw
                    .iter()
                    .position(|(text, _)| *text == "PASS ****")
                    .unwrap();
                assert!(opts > pass);
                if succeeds {
                    assert!(!logs.iter().any(|(_, kind)| matches!(kind, LogKind::Error)));
                    assert!(
                        raw.iter()
                            .any(|(text, kind)| text.contains("504 Unknown command")
                                && matches!(kind, LogKind::Response))
                    );
                } else {
                    assert!(
                        raw.iter()
                            .any(|(text, kind)| text.contains("421")
                                && matches!(kind, LogKind::Error))
                    );
                }
            }
            backend.disconnect().await.unwrap();
            server.abort();
        }
    }

    #[tokio::test]
    async fn failed_metadata_transport_discards_connection_but_refusal_does_not() {
        let (port, server) = spawn_ftp_server(TestServer::holding(&[], false)).await;
        let mut backend = FtpBackend::new();
        backend.connect(&local_config(port)).await.unwrap();
        assert_eq!(backend.known_size("/unsupported").await, None);
        assert!(backend.is_connected());
        assert_eq!(backend.known_size("/drop-size").await, None);
        assert!(!backend.is_connected());
        assert!(backend.stream.lock().await.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn download_rejects_extra_bytes_arriving_after_advertised_size() {
        let (port, server) = spawn_ftp_server(TestServer::holding(&["/extra"], true)).await;
        let mut backend = FtpBackend::new();
        backend.connect(&local_config(port)).await.unwrap();
        let root = std::env::temp_dir().join(format!("ftp-extra-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let target = root.join("target");
        tokio::fs::write(&target, b"original").await.unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(3),
            backend.download("/extra", &target, false, Arc::new(|_| {})),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            ErrorCode::IntegrityMismatch
        );
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        assert!(!backend.is_connected());
        backend.disconnect().await.unwrap();
        server.abort();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn rejected_keep_alive_marks_connection_lost() {
        let (port, server) = spawn_ftp_server(TestServer::holding(&["/reject-noop"], true)).await;
        let mut backend = FtpBackend::new();
        backend.connect(&local_config(port)).await.unwrap();
        backend.keep_alive_handle.take().unwrap().abort();
        let keep_alive = FtpBackend::spawn_keep_alive(
            backend.stream.clone(),
            backend.busy.clone(),
            backend.connected.clone(),
            Duration::from_millis(10),
        );
        tokio::time::timeout(Duration::from_secs(2), keep_alive)
            .await
            .unwrap()
            .unwrap();
        assert!(!backend.is_connected());
        assert!(backend.stream.lock().await.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn listing_preserves_trailing_spaces_in_remote_names() {
        let (port, server) = spawn_ftp_server(TestServer::holding(&["/hello.txt "], true)).await;
        let mut backend = FtpBackend::new();
        backend.connect(&local_config(port)).await.unwrap();
        assert_eq!(backend.list("/").await.unwrap()[0].name, "hello.txt ");
        backend.disconnect().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn cancelled_control_operation_discards_the_socket() {
        let (port, server) = spawn_ftp_server(TestServer::holding(&[], true)).await;
        let mut backend = FtpBackend::new();
        backend.connect(&local_config(port)).await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(20),
            backend.with_stream(|_| Box::pin(std::future::pending::<BackendResult<()>>())),
        )
        .await;
        assert!(result.is_err());
        assert!(!backend.is_connected());
        assert!(backend.stream.lock().await.is_none());
        backend.disconnect().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn no_replace_rename_refuses_a_taken_target_and_moves_onto_a_free_one() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for size_supported in [true, false] {
            let files = TestServer::holding(&["/staged.part", "/taken.txt"], size_supported);
            let (port, server) = spawn_ftp_server(files.clone()).await;
            let mut backend = FtpBackend::new();
            backend.connect(&local_config(port)).await.unwrap();

            // RNTO would replace it; the check before RNFR is all that stops it.
            let error = backend
                .rename_no_replace("/staged.part", "/taken.txt")
                .await
                .unwrap_err();
            assert!(format!("{error:#}").contains("already exists"), "{error:#}");
            assert_eq!(files.paths(), ["/staged.part", "/taken.txt"]);

            backend
                .rename_no_replace("/staged.part", "/free.txt")
                .await
                .unwrap();
            assert_eq!(files.paths(), ["/free.txt", "/taken.txt"]);
            backend.disconnect().await.unwrap();
            server.abort();
        }
    }

    #[tokio::test]
    async fn local_server_supports_connect_list_disconnect_and_reconnect() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (port, server) = spawn_ftp_server(TestServer::holding(&["/hello.txt"], true)).await;
        let config = local_config(port);
        let mut backend = FtpBackend::new();

        backend.connect(&config).await.unwrap();
        assert!(backend.is_connected());
        let entries = backend.list("/").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "hello.txt");
        assert_eq!(entries[0].size, 5);
        backend.disconnect().await.unwrap();
        assert!(!backend.is_connected());

        backend.connect(&config).await.unwrap();
        assert!(backend.is_connected());
        assert_eq!(backend.list("/").await.unwrap().len(), 1);
        backend.disconnect().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn local_ftps_server_rejects_bad_certificate_unless_explicitly_allowed() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (port, server) = spawn_ftps_server().await;
        let make_config = |allow_invalid_cert| {
            let map = json!({
                "protocol": "ftp",
                "host": "127.0.0.1",
                "port": port,
                "user": "local",
                "password": "test",
                "secure": true,
                "allowInvalidCert": allow_invalid_cert
            })
            .as_object()
            .unwrap()
            .clone();
            crate::protocol::config::ConnectionConfig::from_json_map(&map).unwrap()
        };

        let mut strict_backend = FtpBackend::new();
        let error = strict_backend
            .connect(&make_config(false))
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("TLS handshake failed"));
        assert!(!strict_backend.is_connected());

        let mut permissive_backend = FtpBackend::new();
        permissive_backend
            .connect(&make_config(true))
            .await
            .unwrap();
        assert!(permissive_backend.is_connected());
        permissive_backend.disconnect().await.unwrap();
        assert!(!permissive_backend.is_connected());
        server.abort();
    }

    const MATCHING_ROOT_CERT_DER: &str = "MIIBhDCCASqgAwIBAgIUb+aUDSU0xdgv8DyDqyweoBbNY2IwCgYIKoZIzj0EAwIwHzEdMBsGA1UEAwwUZnRwZWFjaC10ZXN0LXJvb3QtY2EwIBcNMjYwODI5MTg1NDE5WhgPMjEyNjA4MDUxODU0MTlaMB8xHTAbBgNVBAMMFGZ0cGVhY2gtdGVzdC1yb290LWNhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAER9qbh6qJqIt9daFwpqqwfliFHFlIGfaCJWAb2dFxrNuzd91LsTjvW/RlheCJMzIZrv83d/L6mqt8UgL+LDHhqqNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFMaBfeeoVBs54Dvo0Sfk0qNhgO/GMAoGCCqGSM49BAMCA0gAMEUCIFkn2z+GloHeuNRJr922v1nlK2+yr0b6dJ7pLXY0IwL8AiEAjGntu0RK6TTuIuTdP0uNbMAUnGGDOdYQHYoKLm6amWo=";
    const MATCHING_LEAF_CERT_DER: &str = "MIIBvzCCAWWgAwIBAgIUWjQBguKnJwGAYeIVifukEv8gnDkwCgYIKoZIzj0EAwIwHzEdMBsGA1UEAwwUZnRwZWFjaC10ZXN0LXJvb3QtY2EwIBcNMjYwODI5MTg1NDIwWhgPMjEyNjA4MDUxODU0MjBaMBQxEjAQBgNVBAMMCTEyNy4wLjAuMTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABHwttXYm5NqoSl/OAECWZCe+05Xox2b1CRbi5DD06G+giQwHY2Y/OdPLLi9/RXmlRbaZIylbZ248cz9z5a4xamyjgYcwgYQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDwYDVR0RBAgwBocEfwAAATAdBgNVHQ4EFgQUcbODXE4zLwiGgbRcN2o6vZdCIC4wHwYDVR0jBBgwFoAUxoF956hUGzngO+jRJ+TSo2GA78YwCgYIKoZIzj0EAwIDSAAwRQIhAJJuw37Zo/u97GiDu39z8qbWMjxpTeRRM1h0KbcCESjtAiBeUGrcOteQZ4pTaMyuv6UPfKQzaGxxroBQoJeasrY9Ug==";
    const MATCHING_LEAF_KEY_DER: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgno6yGLnBy7FvEU9JgjG1Xq0iKPB4ZGEDELeHt/rFhxWhRANCAAR8LbV2JuTaqEpfzgBAlmQnvtOV6Mdm9QkW4uQw9OhvoIkMB2NmPznTyy4vf0V5pUW2mSMpW2duPHM/c+WuMWps";

    const WRONG_CA_CERT_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBkDCCATWgAwIBAgIUT5Izs46mU5CLqTxbYVK1FHSzVnEwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdW5yZWxhdGVkLWNhLnRlc3QwIBcNMjYwODI5MTg1MDQyWhgP
MjEyNjA4MDUxODUwNDJaMBwxGjAYBgNVBAMMEXVucmVsYXRlZC1jYS50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+KFxAsEm8gU/GoOGhY09s8bFkO20BY5A
fP5sRvzIuAGeIm9iJcFey4X/9lGMNuR7QmkBQhyYbFu9hiCyR83buaNTMFEwHQYD
VR0OBBYEFFinzsbHuiL5d5gQHsvPCiwLDahMMB8GA1UdIwQYMBaAFFinzsbHuiL5
d5gQHsvPCiwLDahMMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIh
ALLCQwcz39/hflNRSxKoOe11ejzMMeCgyTDNqsiDMxVSAiEAzbZlpHjZq001C5vi
nfhou3BTAtiYqzFm/Rh6t9+2OLA=
-----END CERTIFICATE-----
";

    fn pem_wrap_certificate(base64_der: &str) -> String {
        let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
        for chunk in base64_der.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).unwrap());
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
        pem
    }

    #[tokio::test]
    async fn local_ftps_server_accepts_a_matching_custom_ca_and_rejects_a_mismatched_one() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let decode = |value| {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .unwrap()
        };
        let (port, server) = spawn_ftps_server_with_cert(
            decode(MATCHING_LEAF_CERT_DER),
            decode(MATCHING_LEAF_KEY_DER),
        )
        .await;
        let dir =
            std::env::temp_dir().join(format!("ftpeach-ca-cert-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let matching_ca_path = dir.join("matching-ca.pem");
        let wrong_ca_path = dir.join("wrong-ca.pem");
        tokio::fs::write(
            &matching_ca_path,
            pem_wrap_certificate(MATCHING_ROOT_CERT_DER),
        )
        .await
        .unwrap();
        tokio::fs::write(&wrong_ca_path, WRONG_CA_CERT_PEM)
            .await
            .unwrap();

        let make_config = |ca_cert_path: &std::path::Path| {
            let map = json!({
                "protocol": "ftp",
                "host": "127.0.0.1",
                "port": port,
                "user": "local",
                "password": "test",
                "secure": true,
                "caCertPath": ca_cert_path.to_string_lossy(),
            })
            .as_object()
            .unwrap()
            .clone();
            crate::protocol::config::ConnectionConfig::from_json_map(&map).unwrap()
        };

        let mut wrong_ca_backend = FtpBackend::new();
        let error = wrong_ca_backend
            .connect(&make_config(&wrong_ca_path))
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("TLS handshake failed"));
        assert!(!wrong_ca_backend.is_connected());

        let mut matching_ca_backend = FtpBackend::new();
        matching_ca_backend
            .connect(&make_config(&matching_ca_path))
            .await
            .unwrap();
        assert!(matching_ca_backend.is_connected());
        matching_ca_backend.disconnect().await.unwrap();

        server.abort();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

#[cfg(test)]
mod recursive_stop_tests {
    //! Uploads stopped partway, and the folders they leave behind, against a
    //! server that behaves like pure-ftpd: LIST leaves out the names that
    //! start with a dot, MLSD lists everything, and a data connection that
    //! closes simply ends the file.
    use super::*;
    use crate::application::recursive_transfer::{self, Endpoint, Intent, Report};
    use crate::application::transfer_service::CancelIntent;
    use crate::session::{Session, Sessions};
    use crate::transfer::progress::ProgressEmitter;
    use crate::transfer::transfer_pool::{BackendFactory, BoxBackend, PoolSize, TransferPool};
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::tcp::OwnedWriteHalf;
    use tokio::net::{TcpListener, TcpStream};

    /// About the size of the file in the report.
    const FILE_SIZE: usize = 330_000;

    #[derive(Default)]
    struct Disk {
        dirs: BTreeSet<String>,
        files: BTreeMap<String, Vec<u8>>,
        /// FEAT announces MLST...
        offers_mlst: bool,
        /// ...and MLSD is turned away all the same.
        refuses_mlsd: bool,
        denies_cwd: bool,
        refuses_size: bool,
        /// DELEs to refuse before honouring them again.
        deletes_to_refuse: usize,
        /// How long the server takes over each 4 KiB it receives.
        pace: Duration,
    }

    type Shared = Arc<std::sync::Mutex<Disk>>;

    fn disk(configure: impl FnOnce(&mut Disk)) -> Shared {
        let mut disk = Disk {
            offers_mlst: true,
            ..Default::default()
        };
        disk.dirs.insert("/".to_string());
        configure(&mut disk);
        Arc::new(std::sync::Mutex::new(disk))
    }

    fn parent(path: &str) -> &str {
        match path.trim_end_matches('/').rsplit_once('/') {
            Some((parent, _)) if !parent.is_empty() => parent,
            _ => "/",
        }
    }

    fn name(path: &str) -> &str {
        path.rsplit('/').next().unwrap_or(path)
    }

    fn resolve(cwd: &str, argument: &str) -> String {
        let joined = if argument.starts_with('/') {
            argument.to_string()
        } else {
            format!("{}/{argument}", cwd.trim_end_matches('/'))
        };
        match joined.trim_end_matches('/') {
            "" => "/".to_string(),
            trimmed => trimmed.to_string(),
        }
    }

    impl Disk {
        /// Everything directly in `dir`, with each file's size.
        fn children(&self, dir: &str) -> Vec<(String, Option<usize>)> {
            let dirs = self
                .dirs
                .iter()
                .filter(|path| path.as_str() != dir && parent(path) == dir)
                .map(|path| (name(path).to_string(), None));
            let files = self
                .files
                .iter()
                .filter(|(path, _)| parent(path) == dir)
                .map(|(path, bytes)| (name(path).to_string(), Some(bytes.len())));
            dirs.chain(files).collect()
        }

        fn list(&self, dir: &str) -> String {
            self.children(dir)
                .into_iter()
                .filter(|(name, _)| !name.starts_with('.'))
                .map(|(name, size)| match size {
                    None => format!("drwxr-xr-x 1 owner group 0 Nov 05 2018 {name}\r\n"),
                    Some(size) => format!("-rw-r--r-- 1 owner group {size} Nov 05 2018 {name}\r\n"),
                })
                .collect()
        }

        fn mlsd(&self, dir: &str) -> String {
            let mut listing = "type=cdir;modify=20181105000000; .\r\n".to_string();
            for (name, size) in self.children(dir) {
                listing.push_str(&match size {
                    None => format!("type=dir;modify=20181105000000; {name}\r\n"),
                    Some(size) => {
                        format!("type=file;size={size};modify=20181105000000; {name}\r\n")
                    }
                });
            }
            listing
        }

        fn is_empty_dir(&self, dir: &str) -> bool {
            self.children(dir).is_empty()
        }
    }

    async fn accept(passive: &mut Option<TcpListener>) -> Option<TcpStream> {
        let listener = passive.take()?;
        let (socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .ok()?
            .ok()?;
        Some(socket)
    }

    /// Takes a file in over a slow link. Closed, the data connection ends the
    /// file, the way stream mode defines it; reset, the upload was abandoned.
    async fn store(
        disk: &Shared,
        path: String,
        append: bool,
        passive: &mut Option<TcpListener>,
        writer: &mut OwnedWriteHalf,
    ) -> String {
        {
            let mut disk = disk.lock().unwrap();
            if !disk.dirs.contains(parent(&path)) {
                return "553 Cannot store".to_string();
            }
            let file = disk.files.entry(path.clone()).or_default();
            if !append {
                file.clear();
            }
        }
        if writer.write_all(b"150 Ok to send data\r\n").await.is_err() {
            return String::new();
        }
        let Some(mut data) = accept(passive).await else {
            return "425 No data connection".to_string();
        };
        let pace = disk.lock().unwrap().pace;
        let mut buf = vec![0u8; 4096];
        loop {
            match data.read(&mut buf).await {
                Ok(0) => return "226 Transfer complete".to_string(),
                Ok(n) => {
                    if let Some(file) = disk.lock().unwrap().files.get_mut(&path) {
                        file.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => return "426 Transfer aborted".to_string(),
            }
            tokio::time::sleep(pace).await;
        }
    }

    async fn send_listing(
        listing: String,
        passive: &mut Option<TcpListener>,
        writer: &mut OwnedWriteHalf,
    ) -> String {
        if writer
            .write_all(b"150 Here comes the listing\r\n")
            .await
            .is_err()
        {
            return String::new();
        }
        let Some(mut data) = accept(passive).await else {
            return "425 No data connection".to_string();
        };
        let _ = data.write_all(listing.as_bytes()).await;
        let _ = data.shutdown().await;
        "226 Transfer complete".to_string()
    }

    async fn serve(socket: TcpStream, disk: Shared) {
        let (reader, mut writer) = socket.into_split();
        let mut lines = BufReader::new(reader).lines();
        let mut passive: Option<TcpListener> = None;
        let mut renaming: Option<String> = None;
        let mut cwd = "/".to_string();
        if writer.write_all(b"220 ready\r\n").await.is_err() {
            return;
        }
        while let Ok(Some(line)) = lines.next_line().await {
            let (command, argument) = line.split_once(' ').unwrap_or((line.as_str(), ""));
            let command = command.to_ascii_uppercase();
            let path = resolve(&cwd, argument);
            let reply = match command.as_str() {
                "OPTS" | "TYPE" | "NOOP" => "200 OK".to_string(),
                "USER" => "331 Password required".to_string(),
                "PASS" => "230 Logged in".to_string(),
                "SYST" => "215 UNIX Type: L8".to_string(),
                "FEAT" => if disk.lock().unwrap().offers_mlst {
                    "211-Features\r\n EPSV\r\n SIZE\r\n MLST type*;size*;modify*;\r\n211 End"
                } else {
                    "211-Features\r\n EPSV\r\n SIZE\r\n211 End"
                }
                .to_string(),
                "EPSV" | "PASV" => {
                    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let port = listener.local_addr().unwrap().port();
                    passive = Some(listener);
                    if command == "EPSV" {
                        format!("229 Entering Extended Passive Mode (|||{port}|)")
                    } else {
                        format!(
                            "227 Entering Passive Mode (127,0,0,1,{},{})",
                            port / 256,
                            port % 256
                        )
                    }
                }
                "CWD" => {
                    if disk.lock().unwrap().denies_cwd {
                        "550 Permission denied".to_string()
                    } else if disk.lock().unwrap().dirs.contains(&path) {
                        cwd = path;
                        "250 OK".to_string()
                    } else {
                        "550 No such directory".to_string()
                    }
                }
                "PWD" => format!("257 \"{cwd}\""),
                "MKD" => {
                    let mut disk = disk.lock().unwrap();
                    if disk.dirs.contains(&path)
                        || disk.files.contains_key(&path)
                        || !disk.dirs.contains(parent(&path))
                    {
                        "550 Cannot create".to_string()
                    } else {
                        disk.dirs.insert(path.clone());
                        format!("257 \"{path}\" created")
                    }
                }
                "RMD" => {
                    let mut disk = disk.lock().unwrap();
                    if disk.dirs.contains(&path) && disk.is_empty_dir(&path) {
                        disk.dirs.remove(&path);
                        "250 Removed".to_string()
                    } else {
                        "550 Directory not empty".to_string()
                    }
                }
                "DELE" => {
                    let mut disk = disk.lock().unwrap();
                    if disk.deletes_to_refuse > 0 {
                        disk.deletes_to_refuse -= 1;
                        "550 Cannot delete".to_string()
                    } else if disk.files.remove(&path).is_some() {
                        "250 Deleted".to_string()
                    } else {
                        "550 No such file".to_string()
                    }
                }
                "SIZE" if disk.lock().unwrap().refuses_size => "502 Not implemented".to_string(),
                "SIZE" => match disk.lock().unwrap().files.get(&path) {
                    Some(bytes) => format!("213 {}", bytes.len()),
                    None => "550 No such file".to_string(),
                },
                "RNFR" => {
                    renaming = Some(path);
                    "350 Ready for RNTO".to_string()
                }
                "RNTO" => {
                    let from = renaming.take().unwrap_or_default();
                    let mut disk = disk.lock().unwrap();
                    match disk.files.remove(&from) {
                        Some(bytes) => {
                            disk.files.insert(path, bytes);
                            "250 Renamed".to_string()
                        }
                        None => "550 No such file".to_string(),
                    }
                }
                "LIST" | "MLSD" => {
                    let dir = if argument.is_empty() {
                        cwd.clone()
                    } else {
                        path
                    };
                    let listing = {
                        let disk = disk.lock().unwrap();
                        if !disk.dirs.contains(&dir) {
                            Err("550 No such directory")
                        } else if command == "LIST" {
                            Ok(disk.list(&dir))
                        } else if disk.refuses_mlsd {
                            Err("502 Command not implemented")
                        } else {
                            Ok(disk.mlsd(&dir))
                        }
                    };
                    match listing {
                        Ok(listing) => send_listing(listing, &mut passive, &mut writer).await,
                        Err(reply) => reply.to_string(),
                    }
                }
                "STOR" | "APPE" => {
                    store(&disk, path, command == "APPE", &mut passive, &mut writer).await
                }
                "QUIT" => {
                    let _ = writer.write_all(b"221 Goodbye\r\n").await;
                    return;
                }
                _ => "502 Not implemented".to_string(),
            };
            if writer
                .write_all(format!("{reply}\r\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
    }

    async fn spawn_server(disk: Shared) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(serve(socket, disk.clone()));
            }
        });
        port
    }

    fn config(port: u16) -> crate::protocol::config::ConnectionConfig {
        let map = json!({
            "protocol": "ftp",
            "host": "127.0.0.1",
            "port": port,
            "user": "local",
            "password": "test"
        });
        crate::protocol::config::ConnectionConfig::from_json_map(map.as_object().unwrap()).unwrap()
    }

    /// A live session on a server holding `disk`, reached as a real one is.
    async fn connected(disk: &Shared) -> (Sessions, String) {
        connected_at(config(spawn_server(disk.clone()).await)).await
    }

    async fn connected_at(config: crate::protocol::config::ConnectionConfig) -> (Sessions, String) {
        connected_with_pool(config, PoolSize::Fixed(2)).await
    }

    async fn connected_with_pool(
        config: crate::protocol::config::ConnectionConfig,
        size: PoolSize,
    ) -> (Sessions, String) {
        fn backend(config: &crate::protocol::config::ConnectionConfig) -> BoxBackend {
            if matches!(config, crate::protocol::config::ConnectionConfig::Webdav(_)) {
                Box::new(crate::protocol::webdav::WebDavBackend::new())
            } else {
                Box::new(FtpBackend::new())
            }
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut browse = backend(&config);
        browse.connect(&config).await.unwrap();
        let factory_config = config.clone();
        let factory: BackendFactory = Arc::new(move || {
            let config = factory_config.clone();
            Box::pin(async move {
                let mut backend = backend(&config);
                backend.connect(&config).await?;
                Ok(backend)
            })
        });
        let sessions = Sessions::default();
        let connection_id = uuid::Uuid::new_v4().to_string();
        *sessions.slot_for(&connection_id).lock().await = Some(Session {
            browse_client: browse,
            server: config.server(),
            transfer_pool: TransferPool::new(factory, size),
            browse_timeout_ms: 20_000,
        });
        (sessions, connection_id)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires Docker FTP and WebDAV"]
    async fn docker_simultaneous_ftp_webdav_files_and_empty_folder() {
        let root = std::env::temp_dir().join(format!("ftpeach-parallel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("Folder")).unwrap();
        let bytes: Vec<u8> = (0..1024 * 1024).map(|n| (n % 251) as u8).collect();
        for index in 0..7 {
            std::fs::write(root.join(format!("file{index}")), &bytes).unwrap();
        }
        let remote = format!("/parallel-audit-{}", uuid::Uuid::new_v4());
        let mut endpoints = Vec::new();
        for map in [
            json!({"protocol":"ftp", "host":"127.0.0.1", "port":2131, "user":"testuser", "password":"testpass"}),
            json!({"protocol":"webdav", "webdavUrl":"http://127.0.0.1:6065", "user":"testuser", "password":"testpass"}),
        ] {
            let config =
                crate::protocol::config::ConnectionConfig::from_json_map(map.as_object().unwrap())
                    .unwrap();
            let (sessions, id) = connected_with_pool(config, PoolSize::Unlimited).await;
            sessions
                .slot_for(&id)
                .lock()
                .await
                .as_mut()
                .unwrap()
                .browse_client
                .mkdir(&remote)
                .await
                .unwrap();
            endpoints.push((sessions, id));
        }
        let barrier = Arc::new(tokio::sync::Barrier::new(17));
        let mut tasks = tokio::task::JoinSet::new();
        for (sessions, id) in &endpoints {
            for index in 0..8 {
                let sessions = sessions.clone();
                let id = id.clone();
                let barrier = barrier.clone();
                let name = if index == 7 {
                    "Folder".into()
                } else {
                    format!("file{index}")
                };
                let source = root.join(&name).to_string_lossy().into_owned();
                let target = format!("{remote}/{name}");
                tasks.spawn(async move {
                    barrier.wait().await;
                    if index == 7 {
                        let report = run(
                            &sessions,
                            Intent {
                                id: uuid::Uuid::new_v4().to_string(),
                                source: Endpoint::Local { path: source },
                                target: Endpoint::Remote {
                                    path: target,
                                    connection_id: id,
                                },
                                moving: false,
                                overwrite: false,
                                skip_existing: false,
                                resume_from: None,
                            },
                        )
                        .await;
                        assert!(report.ok, "{name}: {:?}", report.errors);
                    } else {
                        let progress = ProgressEmitter::for_tests(|_| {});
                        let result = crate::application::transfer_service::transfer_upload(
                            &sessions,
                            &progress,
                            id,
                            uuid::Uuid::new_v4().to_string(),
                            source,
                            target,
                            false,
                            Some(false),
                        )
                        .await
                        .unwrap();
                        assert!(
                            matches!(result, crate::ipc::OkResult::Ok { .. }),
                            "{name}: {result:?}"
                        );
                    }
                });
            }
        }
        barrier.wait().await;
        let results = tokio::time::timeout(Duration::from_secs(90), async {
            let mut failures = Vec::new();
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    failures.push(error.to_string());
                }
            }
            failures
        })
        .await;
        let mut mismatches = Vec::new();
        for (sessions, id) in endpoints {
            let slot = sessions.slot_for(&id);
            let mut guard = slot.lock().await;
            let session = guard.as_mut().unwrap();
            for index in 0..7 {
                let mut actual = Vec::new();
                let result = session
                    .browse_client
                    .download_to_writer(&format!("{remote}/file{index}"), &mut actual)
                    .await;
                if result.is_err() || actual != bytes {
                    mismatches.push(format!("{id}/file{index}: {result:?}"));
                }
            }
            let empty = session
                .browse_client
                .list(&format!("{remote}/Folder"))
                .await;
            if !empty.is_ok_and(|entries| entries.is_empty()) {
                mismatches.push(format!("{id}/Folder"));
            }
            let _ = session.browse_client.remove(&remote, true).await;
            session.transfer_pool.destroy().await;
            session.browse_client.disconnect().await.unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            results.as_ref().is_ok_and(|failures| failures.is_empty()),
            "{results:?}"
        );
        assert!(mismatches.is_empty(), "{mismatches:?}");
    }

    #[tokio::test]
    #[ignore = "requires the local Docker Pure-FTPd on port 2131"]
    async fn docker_empty_folder_uses_the_recursive_transfer_path() {
        let mut settings = config(2131);
        let crate::protocol::config::ConnectionConfig::Ftp(ref mut ftp) = settings else {
            unreachable!()
        };
        ftp.user = "testuser".into();
        ftp.password = "testpass".into();
        let (sessions, connection_id) = connected_at(settings).await;
        let root = std::env::temp_dir().join(format!("ftpeach-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("1")).unwrap();
        let remote = format!("/empty-audit-{}", uuid::Uuid::new_v4());
        let mut intent = upload(&root, &connection_id);
        intent.target = Endpoint::Remote {
            path: remote.clone(),
            connection_id: connection_id.clone(),
        };
        let report = tokio::time::timeout(Duration::from_secs(30), run(&sessions, intent))
            .await
            .unwrap();
        let slot = sessions.slot_for(&connection_id);
        let mut session = slot.lock().await;
        let session = session.as_mut().unwrap();
        let listing = session.browse_client.list(&remote).await;
        let _ = session.browse_client.remove_empty_directory(&remote).await;
        session.transfer_pool.destroy().await;
        session.browse_client.disconnect().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(report.ok, "{:?}", report.errors);
        assert!(listing.unwrap().is_empty());
    }

    #[tokio::test]
    async fn mkdir_preserves_working_directory_for_reused_connections() {
        let disk = disk(|_| {});
        let mut backend = FtpBackend::new();
        backend
            .connect(&config(spawn_server(disk.clone()).await))
            .await
            .unwrap();
        backend.mkdir("/parent/child").await.unwrap();
        backend.mkdir("sibling").await.unwrap();
        backend.mkdir("/parent/child").await.unwrap();
        backend.mkdir("another").await.unwrap();
        let disk = disk.lock().unwrap();
        for path in ["/parent/child", "/sibling", "/another"] {
            assert!(disk.dirs.contains(path), "{path}");
        }
    }

    #[tokio::test]
    async fn empty_directory_creation_does_not_require_cwd_permission() {
        let disk = disk(|disk| disk.denies_cwd = true);
        let mut backend = FtpBackend::new();
        backend
            .connect(&config(spawn_server(disk.clone()).await))
            .await
            .unwrap();
        backend.mkdir("/Folder").await.unwrap();
        assert!(disk.lock().unwrap().dirs.contains("/Folder"));
        assert!(backend.is_connected());
    }

    #[tokio::test]
    async fn shrinking_upload_source_fails_even_when_size_is_unsupported() {
        let disk = disk(|disk| disk.refuses_size = true);
        let mut backend = FtpBackend::new();
        backend
            .connect(&config(spawn_server(disk.clone()).await))
            .await
            .unwrap();
        let root = source_folder();
        let source = root.join("1/File.docx");
        let changing = source.clone();
        let done = Arc::new(AtomicBool::new(false));
        let seen = done.clone();
        let result = backend
            .upload(
                &source,
                "/file",
                false,
                Arc::new(move |event| match event {
                    ProgressInfo::Progress { .. } => {
                        std::fs::OpenOptions::new()
                            .write(true)
                            .open(&changing)
                            .unwrap()
                            .set_len(0)
                            .unwrap();
                    }
                    ProgressInfo::Done => seen.store(true, Ordering::SeqCst),
                    _ => {}
                }),
            )
            .await;
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&result.unwrap_err()).code,
            ErrorCode::IntegrityMismatch
        );
        assert!(!done.load(Ordering::SeqCst));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A local folder "1" holding a single file.
    fn source_folder() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("ftpeach-ftp-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("1")).unwrap();
        std::fs::write(root.join("1/File.docx"), vec![7u8; FILE_SIZE]).unwrap();
        root
    }

    fn upload(root: &std::path::Path, connection_id: &str) -> Intent {
        Intent {
            id: uuid::Uuid::new_v4().to_string(),
            source: Endpoint::Local {
                path: root.join("1").to_string_lossy().into_owned(),
            },
            target: Endpoint::Remote {
                path: "/1".into(),
                connection_id: connection_id.to_owned(),
            },
            moving: false,
            overwrite: false,
            skip_existing: false,
            resume_from: None,
        }
    }

    async fn run(sessions: &Sessions, intent: Intent) -> Report {
        let progress = ProgressEmitter::for_tests(|_| {});
        recursive_transfer::run(sessions, Some(&progress), intent).await
    }

    /// Uploads the folder and stops it once its file is partway onto the
    /// server, answering with how long the stop took to settle.
    async fn stop_midway(disk: &Shared) -> (Duration, Report) {
        let (sessions, connection_id) = connected(disk).await;
        let root = source_folder();
        let intent = upload(&root, &connection_id);
        let id = intent.id.clone();
        let walk = tokio::spawn(async move { run(&sessions, intent).await });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !disk
                .lock()
                .unwrap()
                .files
                .iter()
                .any(|(path, bytes)| path.starts_with("/1/") && !bytes.is_empty())
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the upload never reached the server");
        let stopped = std::time::Instant::now();
        recursive_transfer::cancel(&id, CancelIntent::Stop);
        let report = tokio::time::timeout(Duration::from_secs(30), walk)
            .await
            .expect("the stopped walk never settled")
            .unwrap();
        let took = stopped.elapsed();
        let _ = std::fs::remove_dir_all(root);
        (took, report)
    }

    fn assert_nothing_left(disk: &Shared) {
        let disk = disk.lock().unwrap();
        assert!(disk.files.is_empty(), "{:?}", disk.files.keys());
        assert_eq!(disk.dirs.iter().collect::<Vec<_>>(), ["/"]);
    }

    #[tokio::test]
    async fn a_folder_holding_only_hidden_files_is_listed_and_removed_whole() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let disk = disk(|disk| {
            disk.dirs.insert("/1".to_string());
            disk.files
                .insert("/1/.hidden".to_string(), b"left".to_vec());
        });
        let mut backend = FtpBackend::new();
        backend
            .connect(&config(spawn_server(disk.clone()).await))
            .await
            .unwrap();
        let names: Vec<String> = backend
            .list("/1")
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, [".hidden"]);
        backend.remove("/1", true).await.unwrap();
        backend.disconnect().await.unwrap();
        assert_nothing_left(&disk);
    }

    #[tokio::test]
    async fn a_server_that_turns_mlsd_away_is_listed_by_list() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let disk = disk(|disk| {
            disk.refuses_mlsd = true;
            disk.dirs.insert("/1".to_string());
            disk.files
                .insert("/1/visible".to_string(), b"here".to_vec());
        });
        let mut backend = FtpBackend::new();
        backend
            .connect(&config(spawn_server(disk).await))
            .await
            .unwrap();
        for _ in 0..2 {
            let names: Vec<String> = backend
                .list("/1")
                .await
                .unwrap()
                .into_iter()
                .map(|entry| entry.name)
                .collect();
            assert_eq!(names, ["visible"]);
        }
        backend.disconnect().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stopped_folder_upload_settles_at_once_and_takes_back_what_it_wrote() {
        // Slow enough that the whole file takes seconds to arrive.
        let disk = disk(|disk| disk.pace = Duration::from_millis(50));
        let (took, report) = stop_midway(&disk).await;
        assert_eq!(
            report.errors[0].code,
            ErrorCode::Cancelled,
            "{:?}",
            report.errors
        );
        // Closed rather than reset, the data connection went on delivering
        // the file, and the server answered QUIT only once all of it was in.
        assert!(took < Duration::from_secs(2), "the stop took {took:?}");
        assert_nothing_left(&disk);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_staging_file_the_stop_could_not_delete_goes_with_its_folder() {
        let disk = disk(|disk| {
            disk.pace = Duration::from_millis(50);
            disk.deletes_to_refuse = 1;
        });
        let (_, report) = stop_midway(&disk).await;
        assert_eq!(
            report.errors[0].code,
            ErrorCode::Cancelled,
            "{:?}",
            report.errors
        );
        assert_nothing_left(&disk);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_uninterrupted_folder_upload_lands_whole() {
        let disk = disk(|_| {});
        let (sessions, connection_id) = connected(&disk).await;
        let root = source_folder();
        let report = run(&sessions, upload(&root, &connection_id)).await;
        assert!(report.ok, "{:?}", report.errors);
        let disk = disk.lock().unwrap();
        let landed = &disk.files["/1/File.docx"];
        assert_eq!(landed.len(), FILE_SIZE);
        assert!(landed.iter().all(|&byte| byte == 7));
        assert_eq!(disk.files.len(), 1, "{:?}", disk.files.keys());
        drop(disk);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use serde_json::json;

    fn ensure_crypto_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn connects_lists_and_downloads_from_rebex_ftps() {
        let body = async {
            ensure_crypto_provider();
            let mut backend = FtpBackend::new();
            let config = json!({
                "host": "test.rebex.net",
                "port": 21,
                "user": "demo",
                "password": "password",
                "secure": true,
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

            let tmp = std::env::temp_dir().join("ftpeach-live-test-readme.txt");
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
