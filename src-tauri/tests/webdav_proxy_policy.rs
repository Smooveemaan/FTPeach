//! A connection configured without a proxy must take the route the settings
//! describe.
//!
//! reqwest reads `HTTP_PROXY`/`HTTPS_PROXY` from the environment when a
//! client is built, so a WebDAV connection could quietly travel through a
//! proxy the user never configured and, for a `http://` address, hand that
//! proxy the request. The check lives in its own test binary because it has
//! to set a process-wide environment variable, which would otherwise reach
//! every other test building an HTTP client at the same moment.

use app_lib::domain::{Credentials, ServerSettings};
use app_lib::protocol::config::ConnectionConfig;
use app_lib::protocol::webdav::WebDavBackend;
use app_lib::protocol::{ProtocolBackend, SensitiveString};
use app_lib::store::ConnectionDefaults;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BODY: &str = "<multistatus><response><href>/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>";

/// Answers one PROPFIND and reports how many requests it received.
async fn webdav_server() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = std::sync::Arc::clone(&requests);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                match socket.read_u8().await {
                    Ok(byte) => header.push(byte),
                    Err(_) => break,
                }
            }
            let length = String::from_utf8_lossy(&header)
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            let _ = socket.read_exact(&mut vec![0; length]).await;
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 207 Multi-Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
                        BODY.len()
                    )
                    .as_bytes(),
                )
                .await;
        }
    });
    (format!("http://{address}/dav"), requests)
}

#[tokio::test]
async fn a_connection_without_a_proxy_ignores_the_environment_proxy() {
    let (url, requests) = webdav_server().await;
    // A port nothing listens on: a client that took this route would fail
    // instead of quietly reaching the server.
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_address = dead.local_addr().unwrap();
    drop(dead);

    let server: ServerSettings =
        serde_json::from_value(serde_json::json!({ "protocol": "webdav", "webdavUrl": url }))
            .unwrap();
    let credentials = Credentials {
        password: SensitiveString::default(),
        key_passphrase: None,
    };
    let config = ConnectionConfig::build(
        &server,
        credentials,
        &ConnectionDefaults {
            timeout_ms: 20_000,
            active_mode: false,
            strict_host_key_check: true,
            proxy: None,
        },
    )
    .unwrap();

    // SAFETY: this binary runs one test, and nothing else in the process
    // reads the environment while the variable is set.
    unsafe { std::env::set_var("HTTP_PROXY", format!("http://{dead_address}")) };
    let result = WebDavBackend::new().connect(&config).await;
    unsafe { std::env::remove_var("HTTP_PROXY") };

    result.expect("the connection went through the environment's proxy");
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);
}
