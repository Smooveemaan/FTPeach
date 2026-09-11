use super::*;
use std::sync::Arc;

#[tokio::test]
async fn relay_rejects_unsolicited_partial_and_bodyless_success_before_writing() {
    for status in ["206 Partial Content", "204 No Content", "205 Reset Content"] {
        let (mut backend, server) = single_response(status, "").await;
        let mut bytes = Vec::new();
        let error = backend
            .download_to_writer("/file", &mut bytes)
            .await
            .unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            ErrorCode::IntegrityMismatch
        );
        assert!(bytes.is_empty());
        server.await.unwrap();
    }
}

#[test]
fn resumed_range_must_reach_eof_even_when_metadata_size_is_unknown() {
    assert!(validate_content_range(Some("bytes 5-7/10"), 5, None).is_err());
    assert!(validate_content_range(Some("bytes 5-9/10"), 5, None).is_ok());
    assert!(validate_content_range(Some("bytes 5-10/10"), 5, None).is_err());
}

#[tokio::test]
async fn oversized_chunked_download_stops_before_eof_and_preserves_destination() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for method in ["PROPFIND", "HEAD", "GET"] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap();
            assert!(header.starts_with(method));
            let length = header
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            socket.read_exact(&mut vec![0; length]).await.unwrap();
            match method {
                "PROPFIND" => {
                    let body = "<multistatus><response><href>/file</href><propstat><prop><getcontentlength>3</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>";
                    socket.write_all(format!("HTTP/1.1 207 Multi-Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
                "HEAD" => socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap(),
                _ => {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n").await.unwrap();
                    std::future::pending::<()>().await;
                }
            }
        }
    });
    let mut backend = WebDavBackend {
        client: Some(Client::new()),
        base_url: format!("http://{address}"),
        ..Default::default()
    };
    let root = std::env::temp_dir().join(format!("webdav-oversize-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let target = root.join("target");
    tokio::fs::write(&target, b"original").await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        backend.download("/file", &target, false, Arc::new(|_| {})),
    )
    .await;
    server.abort();
    let error = result
        .expect("must reject excess bytes without waiting for EOF")
        .unwrap_err();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&error).code,
        ErrorCode::IntegrityMismatch
    );
    assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
    tokio::fs::remove_dir_all(root).await.unwrap();
}

async fn single_response(status: &str, body: &str) -> (WebDavBackend, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        let length = String::from_utf8_lossy(&header)
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        socket.read_exact(&mut vec![0; length]).await.unwrap();
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (
        WebDavBackend {
            client: Some(Client::new()),
            base_url: format!("http://{address}/encoded%20base"),
            ..Default::default()
        },
        task,
    )
}

#[tokio::test]
async fn connect_rejects_a_successful_html_login_page() {
    let (mut backend, server) = single_response("200 OK", "<html>Sign in</html>").await;
    let map = serde_json::json!({"protocol": "webdav", "webdavUrl": backend.base_url})
        .as_object()
        .unwrap()
        .clone();
    let config = crate::protocol::config::ConnectionConfig::from_json_map(&map).unwrap();
    assert!(backend.connect(&config).await.is_err());
    assert!(!backend.is_connected());
    server.await.unwrap();
}

#[tokio::test]
async fn mkdir_accepts_405_only_for_an_existing_collection() {
    for collection in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for method in ["MKCOL", "PROPFIND"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(socket.read_u8().await.unwrap());
                }
                let header = String::from_utf8(header).unwrap();
                assert!(header.starts_with(method));
                let length = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                socket.read_exact(&mut vec![0; length]).await.unwrap();
                let (status, body) = if method == "MKCOL" {
                    ("405 Method Not Allowed", String::new())
                } else {
                    (
                        "207 Multi-Status",
                        format!(
                            "<multistatus><response><href>/folder</href><propstat><prop><resourcetype>{}</resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>",
                            if collection { "<collection/>" } else { "" }
                        ),
                    )
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let mut backend = WebDavBackend {
            client: Some(Client::new()),
            base_url: format!("http://{address}"),
            ..Default::default()
        };
        assert_eq!(backend.mkdir("/folder").await.is_ok(), collection);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn listing_excludes_encoded_self_siblings_and_nested_descendants() {
    let body = r#"<multistatus>
        <response><href>/encoded%20base/dir/</href></response>
        <response><href>/encoded%20base/dir/file%20name</href></response>
        <response><href>/encoded%20base/dir/nested/file</href></response>
        <response><href>/encoded%20base/dir-other/wrong</href></response>
        </multistatus>"#;
    let (mut backend, server) = single_response("207 Multi-Status", body).await;
    let entries = backend.list("/dir").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "file name");
    server.await.unwrap();
}

#[tokio::test]
async fn multistatus_delete_and_move_surface_child_failures() {
    for operation in 0..3 {
        let body = r#"<multistatus><response><href>/locked</href><status>HTTP/1.1 403 Forbidden</status></response></multistatus>"#;
        let (mut backend, server) = single_response("207 Multi-Status", body).await;
        let result = match operation {
            0 => backend.remove("/folder", true).await,
            1 => backend.rename("/folder", "/new").await,
            _ => backend.rename_no_replace("/folder", "/new").await,
        };
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&result.unwrap_err()).code,
            ErrorCode::PermissionDenied
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn rejected_put_does_not_wait_for_a_stalled_source() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let backend = WebDavBackend {
        client: Some(Client::new()),
        idle_timeout: Duration::from_secs(60),
        base_url: format!("http://{address}"),
        ..Default::default()
    };
    let (_producer, mut reader) = tokio::io::duplex(1);
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        backend.send_upload("/file", &mut reader, Some(1024), Arc::new(|_| {})),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&result.unwrap_err()).code,
        ErrorCode::PermissionDenied
    );
    server.abort();
}

#[tokio::test]
async fn propfind_status_is_preserved_when_error_body_stalls() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 100\r\n\r\n")
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        WebDavBackend::propfind(&Client::new(), format!("http://{address}"), 0, "", ""),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&result.unwrap_err()).code,
        ErrorCode::PermissionDenied
    );
    server.abort();
}

#[test]
fn propfind_rejects_truncated_wrong_root_and_over_budget_documents() {
    for xml in [
        "",
        "<html>not DAV</html>",
        "<multistatus><response><href>/file</href>",
        "<multistatus/><multistatus/>",
    ] {
        assert!(parse_propfind(xml).is_err(), "{xml}");
    }
    let xml = format!(
        "<multistatus>{}</multistatus>",
        "<response><href>/file</href></response>"
            .repeat(crate::protocol::MAX_DIRECTORY_ENTRIES + 1)
    );
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&parse_propfind(&xml).err().unwrap()).code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn propstat_status_controls_which_metadata_is_trusted() {
    let entries = parse_propfind(r#"<multistatus><response><href>/file</href>
      <propstat><prop><getcontentlength>0</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
      <propstat><prop><getcontentlength>999</getcontentlength><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 404 Not Found</status></propstat>
      </response></multistatus>"#).unwrap();
    assert_eq!(entries[0].size, Some(0));
    assert!(!entries[0].is_dir);
    let unknown = parse_propfind(r#"<multistatus><response><href>/file</href><propstat><prop><getcontentlength>0</getcontentlength></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>"#).unwrap();
    assert_eq!(unknown[0].size, None);
    assert!(parse_propfind(r#"<multistatus><response><href>/file</href><status>HTTP/1.1 403 Forbidden</status></response></multistatus>"#).is_err());
}

#[tokio::test]
async fn upload_bytes_are_paced_across_http_time_windows() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let length = 64 * 1024;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        let start = std::time::Instant::now();
        let mut windows = std::collections::BTreeMap::<u128, usize>::new();
        let mut received = 0;
        let mut buffer = [0; 4096];
        while received < length {
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0);
            received += n;
            *windows
                .entry(start.elapsed().as_millis() / 250)
                .or_default() += n;
        }
        socket
            .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        windows
    });
    let backend = WebDavBackend {
        client: Some(Client::new()),
        upload_client: Some(Client::new()),
        idle_timeout: Duration::from_secs(5),
        base_url: format!("http://{address}"),
        ..Default::default()
    };
    let limiter = crate::transfer::rate_limiter::RateLimiter::new(length as u64);
    // Exclude the intentional one-second startup token bucket from steady-state pacing.
    limiter.acquire(length as u64).await;
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let progress = observed.clone();
    let start = std::time::Instant::now();
    backend
        .send_upload_with_limiter(
            "/paced",
            &mut std::io::Cursor::new(vec![7; length]),
            Some(length as u64),
            Arc::new(move |info| {
                if let ProgressInfo::Progress { bytes, .. } = info {
                    progress.lock().unwrap().push(bytes);
                }
            }),
            &limiter,
        )
        .await
        .unwrap();
    assert!(start.elapsed() >= Duration::from_millis(850));
    let windows = server.await.unwrap();
    assert!(windows.len() >= 3, "upload arrived in a burst: {windows:?}");
    assert!(
        windows.values().all(|bytes| *bytes <= length / 2),
        "upload exceeded a time window: {windows:?}"
    );
    let progress = observed.lock().unwrap();
    assert!(progress.len() >= 6);
    assert!(progress.windows(2).all(|pair| pair[1] > pair[0]));
    assert_eq!(progress.last(), Some(&(length as u64)));
}

#[tokio::test]
async fn concurrent_gigabyte_uploads_admit_only_sixteen_bounded_readers() {
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};
    struct Source {
        started: bool,
        seen: tokio::sync::mpsc::UnboundedSender<usize>,
    }
    impl AsyncRead for Source {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.started {
                return Poll::Pending;
            }
            self.started = true;
            self.seen.send(buffer.remaining()).unwrap();
            let capacity = buffer.remaining();
            buffer.initialize_unfilled().fill(7);
            buffer.advance(capacity);
            Poll::Ready(Ok(()))
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut connections = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            connections.push(socket);
        }
    });
    let backend = Arc::new(WebDavBackend {
        client: Some(Client::new()),
        upload_client: Some(Client::new()),
        idle_timeout: Duration::from_secs(30),
        base_url: format!("http://{address}"),
        ..Default::default()
    });
    let (seen, mut reads) = tokio::sync::mpsc::unbounded_channel();
    let mut uploads = tokio::task::JoinSet::new();
    for _ in 0..17 {
        let backend = backend.clone();
        let seen = seen.clone();
        uploads.spawn(async move {
            backend
                .send_upload(
                    "/large",
                    &mut Source {
                        started: false,
                        seen,
                    },
                    Some(1 << 30),
                    Arc::new(|_| {}),
                )
                .await
        });
    }
    for _ in 0..16 {
        let capacity = tokio::time::timeout(Duration::from_secs(5), reads.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(capacity <= 64 * 1024);
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), reads.recv())
            .await
            .is_err()
    );
    uploads.abort_all();
    while uploads.join_next().await.is_some() {}
    server.abort();
}

#[tokio::test]
async fn streaming_body_is_length_bounded_and_reports_incremental_progress() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let length = 256 * 1024;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        assert!(
            String::from_utf8(header)
                .unwrap()
                .to_ascii_lowercase()
                .contains(&format!("content-length: {length}"))
        );
        let mut data = vec![0; length];
        socket.read_exact(&mut data).await.unwrap();
        assert!(data.iter().all(|byte| *byte == 7));
        socket
            .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let backend = WebDavBackend {
        client: Some(Client::new()),
        upload_client: Some(Client::new()),
        idle_timeout: Duration::from_secs(5),
        base_url: format!("http://{address}"),
        ..Default::default()
    };
    let progress = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = progress.clone();
    // Extra data models a growing source: only the announced length is read.
    let mut reader = std::io::Cursor::new(vec![7; length + 123]);
    backend
        .send_upload(
            "/file",
            &mut reader,
            Some(length as u64),
            Arc::new(move |info| {
                if let ProgressInfo::Progress { bytes, .. } = info {
                    observed.lock().unwrap().push(bytes);
                }
            }),
        )
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(reader.position(), length as u64);
    let progress = progress.lock().unwrap();
    assert!(progress.len() >= 4);
    assert_eq!(progress.last(), Some(&(length as u64)));
}

#[tokio::test]
async fn stalled_get_body_and_put_response_return_typed_timeouts() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for method in ["GET", "PUT"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).await.unwrap();
            assert!(n > 0);
            if method == "GET" {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx")
                    .await
                    .unwrap();
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let mut backend = WebDavBackend {
            client: Some(
                Client::builder()
                    .read_timeout(Duration::from_millis(40))
                    .build()
                    .unwrap(),
            ),
            upload_client: Some(Client::new()),
            idle_timeout: Duration::from_millis(40),
            base_url: format!("http://{address}"),
            connected: true,
            ..Default::default()
        };
        let result = if method == "GET" {
            backend
                .download_to_writer("/file", &mut tokio::io::sink())
                .await
        } else {
            backend
                .send_upload(
                    "/file",
                    &mut std::io::Cursor::new(b"bytes"),
                    Some(5),
                    Arc::new(|_| {}),
                )
                .await
                .map(|_| ())
        };
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&result.unwrap_err()).code,
            ErrorCode::TimedOut
        );
        server.abort();
    }
}

#[tokio::test]
async fn failed_propfind_never_attempts_empty_put() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for status in [403, 500] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let puts = Arc::new(AtomicUsize::new(0));
        let requests = puts.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let n = socket.read(&mut request).await.unwrap();
                if request[..n].starts_with(b"PUT ") {
                    requests.fetch_add(1, Ordering::SeqCst);
                }
                socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }
        });
        let mut backend = WebDavBackend {
            client: Some(Client::new()),
            base_url: format!("http://{address}"),
            ..Default::default()
        };
        assert!(backend.create_file("/existing").await.is_err());
        assert_eq!(puts.load(Ordering::SeqCst), 0);
        server.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_must_match_resume_offset_and_total() {
        assert!(validate_content_range(Some("bytes 5-9/10"), 5, Some(10)).is_ok());
        assert!(validate_content_range(Some("bytes 4-9/10"), 5, Some(10)).is_err());
        assert!(validate_content_range(Some("bytes 5-9/11"), 5, Some(10)).is_err());
        assert!(validate_content_range(None, 5, Some(10)).is_err());
        assert!(validate_content_range(Some("bytes 5-10/10"), 5, None).is_err());
    }

    #[test]
    fn resume_restarts_when_range_is_ignored_and_rejects_416() {
        assert_eq!(resumed_response_start(StatusCode::OK, 5).unwrap(), 0);
        assert_eq!(
            resumed_response_start(StatusCode::PARTIAL_CONTENT, 5).unwrap(),
            5
        );
        assert!(resumed_response_start(StatusCode::RANGE_NOT_SATISFIABLE, 5).is_err());
    }

    const SAMPLE_MULTISTATUS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/Folder/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Sat, 15 Aug 2026 10:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Folder/Sub%20dir/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Sat, 15 Aug 2026 09:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Folder/report.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>1234</D:getcontentlength>
        <D:getlastmodified>Sat, 15 Aug 2026 08:30:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    #[test]
    fn parses_multistatus_into_raw_entries() {
        let entries = parse_propfind(SAMPLE_MULTISTATUS).unwrap();
        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].href, "/dav/Folder/");
        assert!(entries[0].is_dir);

        assert_eq!(entries[1].href, "/dav/Folder/Sub%20dir/");
        assert!(entries[1].is_dir);

        assert_eq!(entries[2].href, "/dav/Folder/report.txt");
        assert!(!entries[2].is_dir);
        assert_eq!(entries[2].size, Some(1234));
        assert_eq!(
            entries[2]
                .last_modified
                .as_deref()
                .and_then(parse_http_date)
                .map(|d| d.to_rfc3339()),
            Some("2026-08-15T08:30:00+00:00".to_string())
        );
    }

    #[test]
    fn decode_href_percent_decodes_and_strips_host() {
        assert_eq!(
            decode_href("/dav/Folder/Sub%20dir/"),
            "/dav/Folder/Sub dir/"
        );
        assert_eq!(
            decode_href("https://example.com/dav/Folder/"),
            "/dav/Folder/"
        );
    }

    #[test]
    fn href_basename_takes_last_segment() {
        assert_eq!(href_basename("/dav/Folder/Sub dir/"), "Sub dir");
        assert_eq!(href_basename("/dav/Folder/report.txt"), "report.txt");
    }

    #[test]
    fn list_skips_self_entry_and_unsafe_names() {
        let self_path = "/dav/Folder";
        let malicious_href = "/dav/Folder/..";
        let decoded = decode_href(malicious_href);
        assert_ne!(decoded.trim_end_matches('/'), self_path);
        assert!(!is_safe_path_segment(&href_basename(&decoded)));

        let entries = parse_propfind(SAMPLE_MULTISTATUS).unwrap();
        let self_entry_decoded = decode_href(&entries[0].href);
        assert_eq!(self_entry_decoded.trim_end_matches('/'), self_path);

        for href in [
            "/dav/Folder/%2e%2e",
            "/dav/Folder/%2E",
            "/dav/Folder/%2e%2e%5cescape",
        ] {
            let name = href_basename(&decode_href(href));
            assert!(
                !is_safe_path_segment(&name),
                "unsafe WebDAV href accepted: {href} -> {name}"
            );
        }
    }

    #[test]
    fn build_url_percent_encodes_segments() {
        let mut backend = WebDavBackend::new();
        backend.base_url = "https://example.com/dav".to_string();
        assert_eq!(
            backend.build_url("/Folder/Sub dir/report.txt"),
            "https://example.com/dav/Folder/Sub%20dir/report.txt"
        );
        assert_eq!(backend.build_url("/"), "https://example.com/dav/");
    }
}

#[cfg(test)]
mod local_integration_tests {
    use super::*;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct DavState {
        directories: HashSet<String>,
        files: HashMap<String, Vec<u8>>,
    }

    fn propfind_body(state: &DavState, path: &str, depth: u8) -> Option<String> {
        let is_directory = state.directories.contains(path);
        let file = state.files.get(path);
        if !is_directory && file.is_none() {
            return None;
        }
        let mut resources = Vec::new();
        if is_directory {
            resources.push(format!(
                "<D:response><D:href>{path}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
            ));
            if depth == 1 {
                let prefix = format!("{path}/");
                for directory in state.directories.iter().filter(|candidate| {
                    candidate.starts_with(&prefix) && !candidate[prefix.len()..].contains('/')
                }) {
                    resources.push(format!(
                        "<D:response><D:href>{directory}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
                    ));
                }
                for (file_path, contents) in state.files.iter().filter(|(candidate, _)| {
                    candidate.starts_with(&prefix) && !candidate[prefix.len()..].contains('/')
                }) {
                    resources.push(format!(
                        "<D:response><D:href>{file_path}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>{}</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
                        contents.len()
                    ));
                }
            }
        } else if let Some(contents) = file {
            resources.push(format!(
                "<D:response><D:href>{path}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>{}</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
                contents.len()
            ));
        }
        Some(format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">{}</D:multistatus>",
            resources.join("")
        ))
    }

    async fn spawn_stateful_webdav_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(DavState {
            directories: HashSet::from(["/dav".to_string()]),
            files: HashMap::new(),
        }));
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0_u8; 4096];
                    let header_end = loop {
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                        if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n")
                        {
                            break index + 4;
                        }
                    };
                    let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while request.len() < header_end + content_length {
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                    }
                    let mut request_parts = headers
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .split_whitespace();
                    let method = request_parts.next().unwrap_or_default();
                    let path = request_parts
                        .next()
                        .unwrap_or_default()
                        .trim_end_matches('/');
                    let header = |wanted: &str| {
                        headers.lines().find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case(wanted)
                                .then(|| value.trim().to_string())
                        })
                    };
                    let body = &request[header_end..header_end + content_length];
                    let slow_response = method == "GET" && path.ends_with("/slow.bin");

                    let (status, extra_headers, response_body) = {
                        let mut state = state.lock().unwrap();
                        match method {
                            "PROPFIND" => {
                                let depth =
                                    header("depth").and_then(|v| v.parse().ok()).unwrap_or(0);
                                match propfind_body(&state, path, depth) {
                                    Some(xml) => (
                                        "207 Multi-Status",
                                        "Content-Type: application/xml\r\n".to_string(),
                                        xml.into_bytes(),
                                    ),
                                    None => ("404 Not Found", String::new(), Vec::new()),
                                }
                            }
                            "MKCOL" => {
                                state.directories.insert(path.to_string());
                                ("201 Created", String::new(), Vec::new())
                            }
                            "PUT" => {
                                state.files.insert(path.to_string(), body.to_vec());
                                ("201 Created", String::new(), Vec::new())
                            }
                            "GET" => match state.files.get(path) {
                                Some(contents) => {
                                    let start = header("range")
                                        .and_then(|value| {
                                            value.strip_prefix("bytes=").map(str::to_string)
                                        })
                                        .and_then(|value| {
                                            value.trim_end_matches('-').parse::<usize>().ok()
                                        })
                                        .unwrap_or(0);
                                    if start > 0 {
                                        let end = contents.len() - 1;
                                        (
                                            "206 Partial Content",
                                            format!(
                                                "Content-Range: bytes {start}-{end}/{}\r\n",
                                                contents.len()
                                            ),
                                            contents[start..].to_vec(),
                                        )
                                    } else {
                                        ("200 OK", String::new(), contents.clone())
                                    }
                                }
                                None => ("404 Not Found", String::new(), Vec::new()),
                            },
                            "MOVE" => {
                                let destination = header("destination")
                                    .and_then(|value| reqwest::Url::parse(&value).ok())
                                    .map(|url| url.path().trim_end_matches('/').to_string());
                                match (state.files.remove(path), destination) {
                                    (Some(contents), Some(destination)) => {
                                        state.files.insert(destination, contents);
                                        ("201 Created", String::new(), Vec::new())
                                    }
                                    _ => ("404 Not Found", String::new(), Vec::new()),
                                }
                            }
                            "DELETE" => {
                                state.files.remove(path);
                                state.directories.remove(path);
                                let prefix = format!("{path}/");
                                state
                                    .files
                                    .retain(|candidate, _| !candidate.starts_with(&prefix));
                                state
                                    .directories
                                    .retain(|candidate| !candidate.starts_with(&prefix));
                                ("204 No Content", String::new(), Vec::new())
                            }
                            _ => ("405 Method Not Allowed", String::new(), Vec::new()),
                        }
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        response_body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    if slow_response {
                        for chunk in response_body.chunks(1024) {
                            if socket.write_all(chunk).await.is_err() {
                                return;
                            }
                            tokio::time::sleep(Duration::from_millis(15)).await;
                        }
                    } else {
                        let _ = socket.write_all(&response_body).await;
                    }
                });
            }
        });
        (format!("http://{address}/dav"), handle)
    }

    async fn spawn_webdav_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0_u8; 2048];
                    let header_end = loop {
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                        if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n")
                        {
                            break index + 4;
                        }
                    };
                    let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .or_else(|| line.strip_prefix("Content-Length: "))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while request.len() < header_end + content_length {
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                    }
                    let request_line = headers.lines().next().unwrap_or_default();
                    if !request_line.starts_with("PROPFIND /dav/") {
                        let _ = socket
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                        return;
                    }
                    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/dav/hello.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>5</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>"#;
                    let response = format!(
                        "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{address}/dav"), handle)
    }

    #[tokio::test]
    async fn local_server_supports_connect_list_disconnect_and_reconnect() {
        let (url, server) = spawn_webdav_server().await;
        let config =
            json!({ "protocol": "webdav", "webdavUrl": url, "user": "local", "password": "test" })
                .as_object()
                .unwrap()
                .clone();
        let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();
        let mut backend = WebDavBackend::new();

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
    async fn local_server_round_trips_file_operations_and_resumed_download() {
        let (url, server) = spawn_stateful_webdav_server().await;
        let config = json!({ "protocol": "webdav", "webdavUrl": url })
            .as_object()
            .unwrap()
            .clone();
        let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();
        let mut backend = WebDavBackend::new();
        let temp_dir =
            std::env::temp_dir().join(format!("ftpeach-webdav-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&temp_dir).await.unwrap();
        let source = temp_dir.join("source.txt");
        let downloaded = temp_dir.join("downloaded.txt");
        let resumed = temp_dir.join("resumed.txt");
        let contents = b"hello from the local WebDAV integration server";
        tokio::fs::write(&source, contents).await.unwrap();
        let progress: ProgressSink = Arc::new(|_| {});

        backend.connect(&config).await.unwrap();
        backend.mkdir("/work/nested").await.unwrap();
        backend
            .upload(&source, "/work/nested/file.txt", false, progress.clone())
            .await
            .unwrap();
        let entries = backend.list("/work/nested").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file.txt");
        assert_eq!(entries[0].size, contents.len() as u64);

        backend
            .download(
                "/work/nested/file.txt",
                &downloaded,
                false,
                progress.clone(),
            )
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&downloaded).await.unwrap(), contents);

        let partial = transfer_file::partial_path(&resumed);
        tokio::fs::write(&partial, &contents[..12]).await.unwrap();
        backend
            .download("/work/nested/file.txt", &resumed, true, progress.clone())
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&resumed).await.unwrap(), contents);

        backend
            .rename("/work/nested/file.txt", "/work/nested/renamed.txt")
            .await
            .unwrap();
        let entries = backend.list("/work/nested").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "renamed.txt");
        backend.remove("/work", true).await.unwrap();
        assert!(backend.list("/work").await.is_err());
        backend.disconnect().await.unwrap();

        tokio::fs::remove_dir_all(&temp_dir).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn local_server_download_can_be_cancelled_without_committing_partial_file() {
        use crate::transfer::transfer_pool::{BackendFactory, PoolSize, TaskFn, TransferPool};

        let (url, server) = spawn_stateful_webdav_server().await;
        let config = json!({ "protocol": "webdav", "webdavUrl": url })
            .as_object()
            .unwrap()
            .clone();
        let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();
        let temp_dir =
            std::env::temp_dir().join(format!("ftpeach-webdav-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&temp_dir).await.unwrap();
        let source = temp_dir.join("slow-source.bin");
        let destination = temp_dir.join("cancelled.bin");
        let contents = vec![b'x'; 128 * 1024];
        tokio::fs::write(&source, &contents).await.unwrap();

        let mut setup_backend = WebDavBackend::new();
        setup_backend.connect(&config).await.unwrap();
        setup_backend
            .upload(&source, "/slow.bin", false, Arc::new(|_| {}))
            .await
            .unwrap();
        setup_backend.disconnect().await.unwrap();

        let factory_config = config.clone();
        let factory: BackendFactory = Arc::new(move || {
            let config = factory_config.clone();
            Box::pin(async move {
                let mut backend = WebDavBackend::new();
                backend.connect(&config).await?;
                Ok(Box::new(backend) as crate::transfer::transfer_pool::BoxBackend)
            })
        });
        let pool = TransferPool::new(factory, PoolSize::Fixed(1));
        let first_progress = Arc::new(tokio::sync::Notify::new());
        let notified = Arc::new(AtomicBool::new(false));
        let progress: ProgressSink = {
            let first_progress = first_progress.clone();
            let notified = notified.clone();
            Arc::new(move |info| {
                if matches!(info, ProgressInfo::Progress { bytes, .. } if bytes > 0)
                    && !notified.swap(true, Ordering::SeqCst)
                {
                    first_progress.notify_one();
                }
            })
        };
        let task_destination = destination.clone();
        let task: TaskFn = Box::new(move |backend| {
            Box::pin(async move {
                backend
                    .download("/slow.bin", &task_destination, false, progress)
                    .await
            })
        });
        let run_pool = pool.clone();
        let run = tokio::spawn(async move { run_pool.run("cancel-download".into(), task).await });

        tokio::time::timeout(Duration::from_secs(2), first_progress.notified())
            .await
            .expect("slow download should report initial progress");
        assert!(pool.cancel("cancel-download"));
        let error = run.await.unwrap().unwrap_err();
        assert!(format!("{error:#}").contains("Canceled by user"));
        assert!(tokio::fs::metadata(&destination).await.is_err());
        let partial = std::fs::read_dir(&temp_dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "part"))
            .unwrap();
        let partial_size = tokio::fs::metadata(&partial).await.unwrap().len();
        assert!(partial_size > 0 && partial_size < contents.len() as u64);

        pool.destroy().await;
        tokio::fs::remove_dir_all(&temp_dir).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn local_slow_server_obeys_connect_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 207 Multi-Status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
        });
        let config = json!({
            "protocol": "webdav",
            "webdavUrl": format!("http://{address}/dav"),
            "timeout": 25
        })
        .as_object()
        .unwrap()
        .clone();
        let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();
        let mut backend = WebDavBackend::new();

        let error = backend.connect(&config).await.unwrap_err();
        assert!(format!("{error:#}").contains("timed out"));
        assert!(!backend.is_connected());
        server.abort();
    }

    #[tokio::test]
    async fn local_broken_server_surfaces_connection_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            // Simulate a peer disappearing after receiving the request, before
            // it can return even an HTTP status line.
            drop(socket);
        });
        let config = json!({
            "protocol": "webdav",
            "webdavUrl": format!("http://{address}/dav"),
            "timeout": 1_000
        })
        .as_object()
        .unwrap()
        .clone();
        let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();
        let mut backend = WebDavBackend::new();

        let error = backend.connect(&config).await.unwrap_err();
        let message = format!("{error:#}");
        assert!(!message.is_empty());
        assert!(!message.contains("timed out"));
        assert!(!backend.is_connected());
        server.await.unwrap();
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn connects_and_round_trips_a_file() {
        let (Ok(url), Ok(user), Ok(pass)) = (
            std::env::var("WEBDAV_URL"),
            std::env::var("WEBDAV_USER"),
            std::env::var("WEBDAV_PASS"),
        ) else {
            panic!("set WEBDAV_URL, WEBDAV_USER, WEBDAV_PASS to run this test");
        };

        let body = async {
            let mut backend = WebDavBackend::new();
            let config =
                json!({ "protocol": "webdav", "webdavUrl": url, "user": user, "password": pass })
                    .as_object()
                    .unwrap()
                    .clone();
            let config = crate::protocol::config::ConnectionConfig::from_json_map(&config).unwrap();

            backend
                .connect(&config)
                .await
                .expect("connect should succeed");
            assert!(backend.is_connected());

            let dir = format!("/ftpeach-rust-webdav-test-{}", uuid::Uuid::new_v4());
            backend.mkdir(&dir).await.expect("mkdir should succeed");

            let remote_file = format!("{dir}/hello.txt");
            backend
                .create_file(&remote_file)
                .await
                .expect("create_file should succeed");

            let local_src = std::env::temp_dir().join("ftpeach-webdav-live-test-src.txt");
            tokio::fs::write(&local_src, b"hello from the rust webdav backend\n")
                .await
                .unwrap();
            let progress: ProgressSink = Arc::new(|_info| {});
            backend
                .upload(&local_src, &remote_file, false, progress.clone())
                .await
                .expect("upload should succeed");

            let entries = backend.list(&dir).await.expect("list should succeed");
            assert!(
                entries
                    .iter()
                    .any(|e| e.name == "hello.txt" && !e.is_directory)
            );

            let local_dst = std::env::temp_dir().join("ftpeach-webdav-live-test-dst.txt");
            let _ = tokio::fs::remove_file(&local_dst).await;
            backend
                .download(&remote_file, &local_dst, false, progress)
                .await
                .expect("download should succeed");
            let downloaded = tokio::fs::read(&local_dst)
                .await
                .expect("downloaded file should exist");
            assert_eq!(downloaded, b"hello from the rust webdav backend\n");

            let renamed = format!("{dir}/renamed.txt");
            backend
                .rename(&remote_file, &renamed)
                .await
                .expect("rename should succeed");

            backend
                .remove(&dir, true)
                .await
                .expect("recursive remove should succeed");

            let _ = tokio::fs::remove_file(&local_src).await;
            let _ = tokio::fs::remove_file(&local_dst).await;

            backend
                .disconnect()
                .await
                .expect("disconnect should succeed");
            assert!(!backend.is_connected());
        };
        tokio::time::timeout(Duration::from_secs(60), body)
            .await
            .expect("live test timed out after 60s");
    }
}
