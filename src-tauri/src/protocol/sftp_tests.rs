use super::*;
// The backend takes only `KnownHostsStore`; these suites hand it the real
// `Store`, which is the implementation that has to keep working.
use crate::store::Store;

#[cfg(test)]
mod transfer_tests {
    use super::*;
    use russh_sftp::protocol::{Attrs, Data, File, Handle, Name, Status};

    #[tokio::test]
    async fn download_window_is_bounded_and_reorders_wire_replies() {
        let (client, mut server) = tokio::io::duplex(1024 * 1024);
        let task = tokio::spawn(async move {
            async fn packet(server: &mut tokio::io::DuplexStream) -> Vec<u8> {
                let length = server.read_u32().await.unwrap();
                assert!(length < 64 * 1024);
                let mut bytes = vec![0; length as usize];
                server.read_exact(&mut bytes).await.unwrap();
                bytes
            }
            assert_eq!(packet(&mut server).await[0], 1);
            server
                .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                .await
                .unwrap();
            for eof in [false, true] {
                let mut requests = Vec::new();
                for _ in 0..READ_WINDOW {
                    requests.push(packet(&mut server).await);
                }
                assert!(
                    tokio::time::timeout(Duration::from_millis(30), server.read_u8())
                        .await
                        .is_err()
                );
                for request in requests.iter().rev() {
                    assert_eq!(request[0], 5); // SSH_FXP_READ
                    let handle_len = u32::from_be_bytes(request[5..9].try_into().unwrap()) as usize;
                    let at = 9 + handle_len;
                    let offset = u64::from_be_bytes(request[at..at + 8].try_into().unwrap());
                    if eof {
                        server.write_u32(17).await.unwrap();
                        server.write_u8(101).await.unwrap();
                        server.write_all(&request[1..5]).await.unwrap();
                        server.write_u32(1).await.unwrap(); // EOF
                        server.write_all(&[0; 8]).await.unwrap();
                    } else {
                        server.write_u32((9 + CHUNK_SIZE) as u32).await.unwrap();
                        server.write_u8(103).await.unwrap(); // DATA
                        server.write_all(&request[1..5]).await.unwrap();
                        server.write_u32(CHUNK_SIZE as u32).await.unwrap();
                        let bytes: Vec<u8> = (offset..offset + CHUNK_SIZE as u64)
                            .map(|n| (n % 251) as u8)
                            .collect();
                        server.write_all(&bytes).await.unwrap();
                    }
                }
            }
        });
        let raw = Arc::new(RawSftpSession::new(client));
        raw.init().await.unwrap();
        let mut bytes = Vec::new();
        let progress: ProgressSink = Arc::new(|_| {});
        let start = 123;
        let total = start + (READ_WINDOW * CHUNK_SIZE) as u64;
        let count = tokio::time::timeout(
            Duration::from_secs(5),
            read_pipelined(&raw, "file", &mut bytes, start, Some(total), &progress),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(count, total);
        assert_eq!(
            bytes,
            (start..total).map(|n| (n % 251) as u8).collect::<Vec<_>>()
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn failed_download_close_does_not_publish_destination() {
        let disk = Arc::new(StdMutex::new(Disk {
            bytes: data(),
            fail_close: true,
            ..Default::default()
        }));
        let mut backend = backend(disk.clone()).await;
        let root = std::env::temp_dir().join(format!("sftp-close-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let target = root.join("target");
        tokio::fs::write(&target, b"original").await.unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let seen = done.clone();
        let result = backend
            .download(
                "/file",
                &target,
                false,
                Arc::new(move |event| {
                    if matches!(event, ProgressInfo::Done) {
                        seen.store(true, Ordering::SeqCst);
                    }
                }),
            )
            .await;
        assert!(result.is_err());
        assert!(!done.load(Ordering::SeqCst));
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        assert_eq!(disk.lock().unwrap().closes, 1);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn write_window_is_bounded_and_accepts_out_of_order_acknowledgements() {
        async fn packet(stream: &mut tokio::io::DuplexStream) -> Vec<u8> {
            let length = stream.read_u32().await.unwrap();
            assert!(length < 64 * 1024);
            let mut bytes = vec![0; length as usize];
            stream.read_exact(&mut bytes).await.unwrap();
            bytes
        }
        async fn ack(stream: &mut tokio::io::DuplexStream, request: &[u8]) {
            stream.write_u32(17).await.unwrap();
            stream.write_u8(101).await.unwrap(); // SSH_FXP_STATUS
            stream.write_all(&request[1..5]).await.unwrap();
            stream.write_all(&[0; 12]).await.unwrap(); // OK, empty message/language
        }
        let (client, mut server) = tokio::io::duplex(1024 * 1024);
        let expected = vec![7; (WRITE_WINDOW + 1) * CHUNK_SIZE];
        let task = tokio::spawn(async move {
            assert_eq!(packet(&mut server).await[0], 1); // INIT
            server
                .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                .await
                .unwrap();
            let mut requests = Vec::new();
            for _ in 0..WRITE_WINDOW {
                requests.push(packet(&mut server).await);
            }
            // No acknowledgement yet: a serial client never reaches here;
            // an unbounded pipeline sends the seventeenth request too early.
            assert!(
                tokio::time::timeout(Duration::from_millis(30), server.read_u8())
                    .await
                    .is_err()
            );
            for request in requests.iter().rev() {
                ack(&mut server, request).await;
            }
            let last = packet(&mut server).await;
            ack(&mut server, &last).await;
            requests.push(last);
            let mut reconstructed = vec![0; (WRITE_WINDOW + 1) * CHUNK_SIZE];
            for request in requests {
                assert_eq!(request[0], 6); // WRITE
                let handle_length = u32::from_be_bytes(request[5..9].try_into().unwrap()) as usize;
                let at = 9 + handle_length;
                let offset = u64::from_be_bytes(request[at..at + 8].try_into().unwrap()) as usize;
                let payload = &request[at + 12..];
                assert_eq!(payload.len(), CHUNK_SIZE);
                reconstructed[offset..offset + payload.len()].copy_from_slice(payload);
            }
            reconstructed
        });
        let raw = Arc::new(RawSftpSession::new(client));
        raw.init().await.unwrap();
        let observed = Arc::new(StdMutex::new(Vec::new()));
        let seen = observed.clone();
        let progress: ProgressSink = Arc::new(move |event| {
            if let ProgressInfo::Progress { bytes, .. } = event {
                seen.lock().unwrap().push(bytes);
            }
        });
        let written = tokio::time::timeout(
            Duration::from_secs(5),
            write_pipelined(
                &raw,
                "file",
                &mut expected.as_slice(),
                0,
                expected.len() as u64,
                &progress,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(written, expected.len() as u64);
        assert_eq!(task.await.unwrap(), expected);
        let values = observed.lock().unwrap();
        assert!(values.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(values.last(), Some(&written));
    }

    #[derive(Default)]
    struct Disk {
        bytes: Vec<u8>,
        closes: usize,
        stats: usize,
        fail_close: bool,
        fail_write: bool,
        oversized_read: bool,
        flags: Vec<OpenFlags>,
        link_root: bool,
        readdirs: usize,
    }
    struct Server(Arc<StdMutex<Disk>>);
    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        }
    }
    impl russh_sftp::server::Handler for Server {
        type Error = StatusCode;
        fn unimplemented(&self) -> StatusCode {
            StatusCode::OpUnsupported
        }
        async fn lstat(&mut self, id: u32, _: String) -> Result<Attrs, StatusCode> {
            Ok(Attrs {
                id,
                attrs: FileAttributes {
                    permissions: Some(if self.0.lock().unwrap().link_root {
                        0o120777
                    } else {
                        0o040755
                    }),
                    ..Default::default()
                },
            })
        }
        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
            Ok(Handle { id, handle: path })
        }
        async fn readdir(&mut self, id: u32, _: String) -> Result<Name, StatusCode> {
            let mut disk = self.0.lock().unwrap();
            disk.readdirs += 1;
            if disk.readdirs > 1 {
                return Err(StatusCode::Eof);
            }
            Ok(Name {
                id,
                files: vec![File::new(
                    "link",
                    FileAttributes {
                        permissions: Some(0o120777),
                        ..Default::default()
                    },
                )],
            })
        }
        async fn open(
            &mut self,
            id: u32,
            filename: String,
            flags: OpenFlags,
            _: FileAttributes,
        ) -> Result<Handle, StatusCode> {
            let mut disk = self.0.lock().unwrap();
            disk.flags.push(flags);
            if flags.contains(OpenFlags::TRUNCATE) {
                disk.bytes.clear();
            }
            Ok(Handle {
                id,
                handle: filename,
            })
        }
        async fn write(
            &mut self,
            id: u32,
            _: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, StatusCode> {
            let mut disk = self.0.lock().unwrap();
            if disk.fail_write {
                return Err(StatusCode::PermissionDenied);
            }
            let offset = offset as usize;
            let size = disk.bytes.len().max(offset + data.len());
            disk.bytes.resize(size, 0);
            disk.bytes[offset..offset + data.len()].copy_from_slice(&data);
            Ok(ok(id))
        }
        async fn read(
            &mut self,
            id: u32,
            _: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, StatusCode> {
            let disk = self.0.lock().unwrap();
            if disk.oversized_read {
                return Ok(Data {
                    id,
                    data: vec![0; len as usize + 1],
                });
            }
            let offset = offset as usize;
            if offset >= disk.bytes.len() {
                return Err(StatusCode::Eof);
            }
            // Deliberately short packets: clients must continue until EOF.
            let end = (offset + (len as usize).min(997)).min(disk.bytes.len());
            Ok(Data {
                id,
                data: disk.bytes[offset..end].to_vec(),
            })
        }
        async fn stat(&mut self, id: u32, _: String) -> Result<Attrs, StatusCode> {
            let mut disk = self.0.lock().unwrap();
            disk.stats += 1;
            Ok(Attrs {
                id,
                attrs: FileAttributes {
                    size: Some(disk.bytes.len() as u64),
                    mtime: Some(42),
                    ..Default::default()
                },
            })
        }
        async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
            let mut disk = self.0.lock().unwrap();
            disk.closes += 1;
            if disk.fail_close {
                Err(StatusCode::Failure)
            } else {
                Ok(ok(id))
            }
        }
    }
    async fn backend(disk: Arc<StdMutex<Disk>>) -> SftpBackend {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        russh_sftp::server::run(server, Server(disk)).await;
        let raw = RawSftpSession::new(client);
        raw.init().await.unwrap();
        let store =
            Store::new_at(std::env::temp_dir().join(format!("sftp-test-{}", uuid::Uuid::new_v4())));
        let backend = SftpBackend::new(Arc::new(store));
        *backend.sftp.write().unwrap() = Some(Arc::new(raw));
        backend
    }
    fn data() -> Vec<u8> {
        (0..CHUNK_SIZE * 35 + 123)
            .map(|n| (n % 251) as u8)
            .collect()
    }

    #[tokio::test]
    async fn recursive_listing_refuses_root_and_child_links_without_following_them() {
        for link_root in [false, true] {
            let disk = Arc::new(StdMutex::new(Disk {
                link_root,
                ..Default::default()
            }));
            let mut backend = backend(disk.clone()).await;
            let error = backend.list_for_recursive("/folder").await.err().unwrap();
            assert!(error.to_string().contains("symbolic link"));
            let disk = disk.lock().unwrap();
            assert_eq!(
                disk.stats, 0,
                "recursive listing must never follow a link with STAT"
            );
            assert_eq!(disk.closes, if link_root { 0 } else { 1 });
        }
    }

    #[tokio::test]
    async fn relay_round_trip_preserves_every_byte_across_short_reads() {
        let disk = Arc::new(StdMutex::new(Disk::default()));
        let mut backend = backend(disk.clone()).await;
        let expected = data();
        backend
            .upload_from_reader(&mut expected.as_slice(), "/file")
            .await
            .unwrap();
        let mut downloaded = Vec::new();
        backend
            .download_to_writer("/file", &mut downloaded)
            .await
            .unwrap();
        assert_eq!(downloaded, expected);
        assert_eq!(disk.lock().unwrap().closes, 2);
    }

    #[tokio::test]
    async fn resumed_upload_uses_offsets_and_close_failure_never_reports_done() {
        let expected = data();
        let root = std::env::temp_dir().join(format!("sftp-transfer-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let source = root.join("source");
        tokio::fs::write(&source, &expected).await.unwrap();
        for fail_close in [false, true] {
            let disk = Arc::new(StdMutex::new(Disk {
                bytes: expected[..12345].to_vec(),
                fail_close,
                ..Default::default()
            }));
            let mut backend = backend(disk.clone()).await;
            let events = Arc::new(StdMutex::new(Vec::new()));
            let seen = events.clone();
            let result = backend
                .upload(
                    &source,
                    "/file",
                    true,
                    Arc::new(move |info| seen.lock().unwrap().push(info)),
                )
                .await;
            assert_eq!(result.is_err(), fail_close);
            let disk = disk.lock().unwrap();
            assert_eq!(disk.bytes, expected);
            assert_eq!(disk.closes, 1);
            assert_eq!(disk.flags.len(), 1);
            assert_eq!(disk.flags[0].bits(), OpenFlags::WRITE.bits());
            assert_eq!(
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event, ProgressInfo::Done)),
                !fail_close
            );
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_write_is_preserved_and_handle_is_closed() {
        let disk = Arc::new(StdMutex::new(Disk {
            fail_write: true,
            fail_close: true,
            ..Default::default()
        }));
        let mut backend = backend(disk.clone()).await;
        let error = backend
            .upload_from_reader(&mut data().as_slice(), "/file")
            .await
            .unwrap_err();
        assert!(error.chain().any(|cause| matches!(cause.downcast_ref::<SftpClientError>(), Some(SftpClientError::Status(status)) if status.status_code == StatusCode::PermissionDenied)));
        assert_eq!(disk.lock().unwrap().closes, 1);
    }

    #[tokio::test]
    async fn oversized_range_reply_is_rejected_and_closed() {
        let disk = Arc::new(StdMutex::new(Disk {
            oversized_read: true,
            ..Default::default()
        }));
        let mut backend = backend(disk.clone()).await;
        assert!(backend.read_range("/file", 0, 12).await.is_err());
        assert_eq!(disk.lock().unwrap().closes, 1);
    }

    #[tokio::test]
    async fn download_fetches_one_metadata_snapshot_and_preserves_short_reads() {
        let expected = data();
        let disk = Arc::new(StdMutex::new(Disk {
            bytes: expected.clone(),
            ..Default::default()
        }));
        let mut backend = backend(disk.clone()).await;
        let root = std::env::temp_dir().join(format!("sftp-download-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let target = root.join("target");
        backend
            .download("/file", &target, false, Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(target).await.unwrap(), expected);
        assert_eq!(disk.lock().unwrap().stats, 1);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

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
                "protocol": "sftp",
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
