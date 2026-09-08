use super::*;
use tokio::net::TcpListener;

async fn loopback_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let client = TcpStream::connect(addr).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    (client, server)
}

#[tokio::test]
async fn socks4a_success_sends_hostname_and_accepts_grant() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut req = vec![0u8; 8]; // VN CD PORT(2) IP(4) — the fixed-size header only
        server.read_exact(&mut req).await.unwrap();
        assert_eq!(&req[0..2], &[0x04, 0x01]);
        assert_eq!(&req[4..8], &[0, 0, 0, 1]); // SOCKS4a sentinel
        let mut userid = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            server.read_exact(&mut byte).await.unwrap();
            if byte[0] == 0 {
                break;
            }
            userid.push(byte[0]);
        }
        let mut host = Vec::new();
        loop {
            server.read_exact(&mut byte).await.unwrap();
            if byte[0] == 0 {
                break;
            }
            host.push(byte[0]);
        }
        assert_eq!(String::from_utf8(host).unwrap(), "example.com");
        server
            .write_all(&[0x00, 0x5a, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
    });
    socks4_handshake(&mut client, "example.com", 21, None)
        .await
        .expect("handshake should succeed");
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks4_rejection_surfaces_as_error() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut req = vec![0u8; 8]; // VN CD PORT(2) IP(4) — the fixed-size header only
        server.read_exact(&mut req).await.unwrap();
        let mut byte = [0u8; 1];
        server.read_exact(&mut byte).await.unwrap(); // NUL after empty userid
        server
            .write_all(&[0x00, 0x5b, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
    });
    let err = socks4_handshake(&mut client, "10.0.0.1", 21, None)
        .await
        .expect_err("rejection should surface as an error");
    assert!(err.to_string().contains("rejected"));
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks5_no_auth_success_leaves_no_bytes_behind() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [0x05, 0x01, 0x00]);
        server.write_all(&[0x05, 0x00]).await.unwrap();

        let mut req_head = [0u8; 5];
        server.read_exact(&mut req_head).await.unwrap();
        assert_eq!(&req_head[..4], &[0x05, 0x01, 0x00, 0x03]);
        let mut host = vec![0u8; req_head[4] as usize];
        server.read_exact(&mut host).await.unwrap();
        assert_eq!(String::from_utf8(host).unwrap(), "ftp.example.com");
        let mut port = [0u8; 2];
        server.read_exact(&mut port).await.unwrap();
        assert_eq!(u16::from_be_bytes(port), 21);

        server
            .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90])
            .await
            .unwrap();
        // Application data the "target" would send next — proves the
        // handshake didn't over-read past the CONNECT reply.
        server.write_all(b"220 welcome\r\n").await.unwrap();
    });
    socks5_handshake(&mut client, "ftp.example.com", 21, None, None)
        .await
        .expect("handshake should succeed");
    let mut trailing = [0u8; 13];
    client.read_exact(&mut trailing).await.unwrap();
    assert_eq!(&trailing, b"220 welcome\r\n");
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks5_username_password_auth_is_sent_when_configured() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut greeting = [0u8; 4];
        server.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [0x05, 0x02, 0x00, 0x02]);
        server.write_all(&[0x05, 0x02]).await.unwrap();

        let mut auth_head = [0u8; 2];
        server.read_exact(&mut auth_head).await.unwrap();
        let mut user = vec![0u8; auth_head[1] as usize];
        server.read_exact(&mut user).await.unwrap();
        assert_eq!(String::from_utf8(user).unwrap(), "alice");
        let mut pass_len = [0u8; 1];
        server.read_exact(&mut pass_len).await.unwrap();
        let mut pass = vec![0u8; pass_len[0] as usize];
        server.read_exact(&mut pass).await.unwrap();
        assert_eq!(String::from_utf8(pass).unwrap(), "s3cret");
        server.write_all(&[0x01, 0x00]).await.unwrap();

        let mut req_head = [0u8; 5];
        server.read_exact(&mut req_head).await.unwrap();
        let mut host = vec![0u8; req_head[4] as usize];
        server.read_exact(&mut host).await.unwrap();
        let mut port = [0u8; 2];
        server.read_exact(&mut port).await.unwrap();
        server
            .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
    });
    socks5_handshake(
        &mut client,
        "ftp.example.com",
        21,
        Some("alice"),
        Some("s3cret"),
    )
    .await
    .expect("handshake should succeed");
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks5_auth_failure_surfaces_as_error() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut greeting = [0u8; 4];
        server.read_exact(&mut greeting).await.unwrap();
        server.write_all(&[0x05, 0x02]).await.unwrap();
        let mut auth_head = [0u8; 2];
        server.read_exact(&mut auth_head).await.unwrap();
        let mut user = vec![0u8; auth_head[1] as usize];
        server.read_exact(&mut user).await.unwrap();
        let mut pass_len = [0u8; 1];
        server.read_exact(&mut pass_len).await.unwrap();
        let mut pass = vec![0u8; pass_len[0] as usize];
        server.read_exact(&mut pass).await.unwrap();
        server.write_all(&[0x01, 0x01]).await.unwrap(); // failure
    });
    let err = socks5_handshake(
        &mut client,
        "ftp.example.com",
        21,
        Some("alice"),
        Some("wrong"),
    )
    .await
    .expect_err("bad credentials should surface as an error");
    assert!(err.to_string().to_lowercase().contains("authentication"));
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks5_rejected_connect_surfaces_reply_code() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        server.write_all(&[0x05, 0x00]).await.unwrap();
        let mut req_head = [0u8; 5];
        server.read_exact(&mut req_head).await.unwrap();
        let mut host = vec![0u8; req_head[4] as usize];
        server.read_exact(&mut host).await.unwrap();
        let mut port = [0u8; 2];
        server.read_exact(&mut port).await.unwrap();
        server
            .write_all(&[0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]) // host unreachable
            .await
            .unwrap();
    });
    let err = socks5_handshake(&mut client, "unreachable.example", 21, None, None)
        .await
        .expect_err("rejected CONNECT should surface as an error");
    assert!(err.to_string().contains("unreachable"));
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks5_encodes_ipv6_targets_with_the_native_address_type() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        server.write_all(&[0x05, 0x00]).await.unwrap();
        let mut request = [0u8; 22]; // VER, CMD, RSV, ATYP, IPv6(16), port(2)
        server.read_exact(&mut request).await.unwrap();
        assert_eq!(&request[..4], &[0x05, 0x01, 0x00, 0x04]);
        assert_eq!(&request[4..20], &std::net::Ipv6Addr::LOCALHOST.octets());
        assert_eq!(u16::from_be_bytes([request[20], request[21]]), 22);
        server
            .write_all(&[
                0x05, 0x00, 0x00, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 22,
            ])
            .await
            .unwrap();
    });
    socks5_handshake(&mut client, "::1", 22, None, None)
        .await
        .expect("IPv6 CONNECT should succeed");
    server_task.await.unwrap();
}

#[tokio::test]
async fn socks4_rejects_ipv6_with_an_actionable_error() {
    let (mut client, _server) = loopback_pair().await;
    let error = socks4_handshake(&mut client, "::1", 21, None)
        .await
        .expect_err("SOCKS4 has no IPv6 address type");
    assert!(error.to_string().contains("use SOCKS5 or HTTP CONNECT"));
}

#[tokio::test]
async fn http_connect_success_leaves_trailing_bytes_untouched() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        let mut total = 0;
        loop {
            let n = server.read(&mut buf[total..]).await.unwrap();
            total += n;
            if buf[..total].ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let req = String::from_utf8_lossy(&buf[..total]);
        assert!(req.starts_with("CONNECT ftp.example.com:21 HTTP/1.1\r\n"));
        assert!(req.contains("Proxy-Authorization: Basic"));
        server
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n220 welcome\r\n")
            .await
            .unwrap();
    });
    http_connect_handshake(
        &mut client,
        "ftp.example.com",
        21,
        Some("alice"),
        Some("s3cret"),
    )
    .await
    .expect("handshake should succeed");
    let mut trailing = [0u8; 13];
    client.read_exact(&mut trailing).await.unwrap();
    assert_eq!(&trailing, b"220 welcome\r\n");
    server_task.await.unwrap();
}

#[tokio::test]
async fn http_connect_non_2xx_status_surfaces_as_error() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        let mut total = 0;
        loop {
            let n = server.read(&mut buf[total..]).await.unwrap();
            total += n;
            if buf[..total].ends_with(b"\r\n\r\n") {
                break;
            }
        }
        server
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .await
            .unwrap();
    });
    let err = http_connect_handshake(&mut client, "ftp.example.com", 21, None, None)
        .await
        .expect_err("non-2xx status should surface as an error");
    assert!(err.to_string().contains("407"));
    server_task.await.unwrap();
}

#[tokio::test]
async fn http_connect_brackets_ipv6_authorities() {
    let (mut client, mut server) = loopback_pair().await;
    let server_task = tokio::spawn(async move {
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            server.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with("CONNECT [::1]:443 HTTP/1.1\r\n"));
        assert!(request.contains("\r\nHost: [::1]:443\r\n"));
        server
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
    });
    http_connect_handshake(&mut client, "::1", 443, None, None)
        .await
        .expect("IPv6 authority should be accepted");
    server_task.await.unwrap();
}
