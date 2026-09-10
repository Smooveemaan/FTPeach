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
                    let reply: &[u8] = if !server.size_supported {
                        b"502 Command not implemented\r\n"
                    } else if server.has(argument) {
                        b"213 5\r\n"
                    } else {
                        b"550 No such file\r\n"
                    };
                    writer.write_all(reply).await.unwrap();
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
                "NOOP" => writer.write_all(b"200 Still here\r\n").await.unwrap(),
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
