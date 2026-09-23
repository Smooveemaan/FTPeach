//! WebDAV through a SOCKS4 proxy.
//!
//! reqwest connects through hyper-util, and hyper-util 0.1.20 writes two NULs
//! after the empty SOCKS4 user id where the protocol has one. A SOCKS4a proxy
//! then reads the server's name as empty; a SOCKS4 proxy forwards the stray
//! NUL to the server, which answers the HTTP request that follows it with 400.
//! The fix (hyperium/hyper-util#307) is not released yet, so reqwest is
//! pointed at this SOCKS5 proxy on the loopback interface instead, which
//! reaches the server through the real proxy with the SOCKS4 client FTP and
//! SFTP use. Remove it once reqwest's hyper-util has the fix.

use super::transport::ProxyConfig;
use anyhow::{Context, Result, bail};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// How many bridged connections may exist at once.
///
/// The listener is on the loopback interface, so any process on this machine
/// can connect to it. Without a bound each of those sockets bought a task
/// and a 30-second handshake window before it had proved it knows the
/// credentials; a few thousand of them cost more than the one WebDAV session
/// the bridge exists for.
const MAX_BRIDGED_CONNECTIONS: usize = 8;

/// A running bridge; dropping it stops it.
pub struct SocksBridge {
    /// The `socks5h://` URL to hand reqwest, credentials included.
    pub url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for SocksBridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start(proxy: ProxyConfig) -> Result<SocksBridge> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    // Other programs on this machine can reach the port too; only a client
    // that knows these may use the proxy behind it.
    let credentials = Arc::new((
        uuid::Uuid::new_v4().simple().to_string(),
        uuid::Uuid::new_v4().simple().to_string(),
    ));
    let url = format!(
        "socks5h://{}:{}@127.0.0.1:{port}",
        credentials.0, credentials.1
    );
    let proxy = Arc::new(proxy);
    let task = tokio::spawn(async move {
        // The connections belong to this task: dropping it, which is what
        // `SocksBridge`'s `Drop` causes, drops the set and stops them too.
        // Detached tasks used to outlive the bridge that spawned them.
        let mut connections = tokio::task::JoinSet::new();
        loop {
            while connections.len() >= MAX_BRIDGED_CONNECTIONS {
                if connections.join_next().await.is_none() {
                    break;
                }
            }
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let proxy = proxy.clone();
            let credentials = credentials.clone();
            connections.spawn(async move {
                let _ = serve(client, &proxy, &credentials).await;
            });
            while connections.try_join_next().is_some() {}
        }
    });
    Ok(SocksBridge { url, task })
}

async fn serve(
    mut client: TcpStream,
    proxy: &ProxyConfig,
    credentials: &(String, String),
) -> Result<()> {
    let (host, port) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, accept_request(&mut client, credentials))
            .await
            .context("SOCKS5 handshake timed out")??;
    let mut server = match super::transport::connect(&host, port, Some(proxy)).await {
        Ok(server) => server,
        Err(error) => {
            // General failure: reqwest reports it as the proxy's.
            let _ = client.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err(error);
        }
    };
    client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    tokio::io::copy_bidirectional(&mut client, &mut server).await?;
    Ok(())
}

/// Reads a SOCKS5 greeting, username/password login (RFC 1929) and CONNECT
/// request, answering with where to connect.
async fn accept_request(
    client: &mut TcpStream,
    credentials: &(String, String),
) -> Result<(String, u16)> {
    let [version, count] = read_array(client).await?;
    let mut methods = vec![0; usize::from(count)];
    client.read_exact(&mut methods).await?;
    if version != 5 || !methods.contains(&2) {
        client.write_all(&[5, 0xff]).await?;
        bail!("the SOCKS5 client does not log in");
    }
    client.write_all(&[5, 2]).await?;

    let [_, user_length] = read_array(client).await?;
    let mut user = vec![0; usize::from(user_length)];
    client.read_exact(&mut user).await?;
    let [password_length] = read_array(client).await?;
    let mut password = vec![0; usize::from(password_length)];
    client.read_exact(&mut password).await?;
    if user != credentials.0.as_bytes() || password != credentials.1.as_bytes() {
        client.write_all(&[1, 1]).await?;
        bail!("wrong SOCKS5 bridge credentials");
    }
    client.write_all(&[1, 0]).await?;

    let [version, command, _, address_type] = read_array(client).await?;
    if version != 5 || command != 1 {
        // Command not supported.
        client.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!("only SOCKS5 CONNECT is bridged");
    }
    let host = match address_type {
        1 => Ipv4Addr::from(read_array::<4>(client).await?).to_string(),
        3 => {
            let [length] = read_array(client).await?;
            let mut name = vec![0; usize::from(length)];
            client.read_exact(&mut name).await?;
            String::from_utf8(name).context("the SOCKS5 host name is not UTF-8")?
        }
        4 => Ipv6Addr::from(read_array::<16>(client).await?).to_string(),
        _ => {
            // Address type not supported.
            client.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            bail!("unknown SOCKS5 address type {address_type}");
        }
    };
    let port = u16::from_be_bytes(read_array(client).await?);
    Ok((host, port))
}

async fn read_array<const N: usize>(client: &mut TcpStream) -> Result<[u8; N]> {
    let mut bytes = [0; N];
    client.read_exact(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::transport::ProxyKind;

    /// A SOCKS4 proxy that checks the request byte for byte, then echoes.
    async fn socks4_proxy() -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            // VN CD DSTPORT DSTIP(0.0.0.1) USERID(empty) NUL "dav.internal" NUL
            let mut request = vec![0; 8 + 1 + 12 + 1];
            stream.read_exact(&mut request).await.unwrap();
            stream
                .write_all(&[0, 0x5a, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            let mut echo = [0; 4];
            stream.read_exact(&mut echo).await.unwrap();
            stream.write_all(&echo).await.unwrap();
            request
        });
        (port, task)
    }

    #[tokio::test]
    async fn bridges_a_socks5_client_to_a_socks4a_proxy() {
        let (proxy_port, proxy) = socks4_proxy().await;
        let bridge = start(ProxyConfig {
            kind: ProxyKind::Socks4,
            host: "127.0.0.1".into(),
            port: proxy_port,
            username: None,
            password: None,
        })
        .await
        .unwrap();
        let url = reqwest::Url::parse(&bridge.url).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", url.port().unwrap()))
            .await
            .unwrap();
        client.write_all(&[5, 1, 2]).await.unwrap();
        assert_eq!(read_array::<2>(&mut client).await.unwrap(), [5, 2]);
        let mut login = vec![1, 32];
        login.extend_from_slice(url.username().as_bytes());
        login.push(32);
        login.extend_from_slice(url.password().unwrap().as_bytes());
        client.write_all(&login).await.unwrap();
        assert_eq!(read_array::<2>(&mut client).await.unwrap(), [1, 0]);
        let mut request = vec![5, 1, 0, 3, 12];
        request.extend_from_slice(b"dav.internal");
        request.extend_from_slice(&443u16.to_be_bytes());
        client.write_all(&request).await.unwrap();
        assert_eq!(read_array::<10>(&mut client).await.unwrap()[..2], [5, 0]);
        client.write_all(b"ping").await.unwrap();
        assert_eq!(&read_array::<4>(&mut client).await.unwrap(), b"ping");

        let mut expected = vec![4, 1, 1, 187, 0, 0, 0, 1, 0];
        expected.extend_from_slice(b"dav.internal\0");
        assert_eq!(proxy.await.unwrap(), expected);
    }

    /// A process on this machine can open as many sockets to the bridge as
    /// it likes; what it cannot do is make the bridge hold one task and one
    /// handshake window per socket.
    #[tokio::test]
    async fn the_bridge_admits_a_bounded_number_of_clients() {
        let bridge = start(ProxyConfig {
            kind: ProxyKind::Socks4,
            host: "127.0.0.1".into(),
            port: 9,
            username: None,
            password: None,
        })
        .await
        .unwrap();
        let port = reqwest::Url::parse(&bridge.url).unwrap().port().unwrap();
        // Silent clients: each one occupies a slot until its handshake
        // window runs out, which is far longer than this test.
        let mut silent = Vec::new();
        for _ in 0..(MAX_BRIDGED_CONNECTIONS * 4) {
            silent.push(TcpStream::connect(("127.0.0.1", port)).await.unwrap());
        }
        // The bridge greets only what it admitted. One more client gets its
        // connection accepted by the OS backlog but no answer.
        let mut extra = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        extra.write_all(&[5, 1, 2]).await.unwrap();
        let answered =
            tokio::time::timeout(Duration::from_millis(300), read_array::<2>(&mut extra)).await;
        assert!(
            answered.is_err(),
            "an unbounded bridge answered every client"
        );

        // Dropping the bridge takes its connections with it rather than
        // leaving detached tasks behind.
        drop(bridge);
        tokio::task::yield_now().await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn refuses_a_client_without_the_credentials() {
        let bridge = start(ProxyConfig {
            kind: ProxyKind::Socks4,
            host: "127.0.0.1".into(),
            port: 9,
            username: None,
            password: None,
        })
        .await
        .unwrap();
        let port = reqwest::Url::parse(&bridge.url).unwrap().port().unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client.write_all(&[5, 1, 0]).await.unwrap();
        assert_eq!(read_array::<2>(&mut client).await.unwrap(), [5, 0xff]);

        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(&[5, 1, 2, 1, 1, b'x', 1, b'y'])
            .await
            .unwrap();
        assert_eq!(read_array::<2>(&mut client).await.unwrap(), [5, 2]);
        assert_eq!(read_array::<2>(&mut client).await.unwrap(), [1, 1]);
    }
}
