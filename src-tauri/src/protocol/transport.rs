//! Shared TCP transport for FTP/SFTP connections. Every outbound TCP
//! connection either backend makes — the control connection, and FTP's
//! passive-mode data connections — goes through `connect()` here, so proxy
//! support (SOCKS4/4a, SOCKS5, HTTP CONNECT — see proxy.rs for the actual
//! handshakes) lives in exactly one place instead of being duplicated per
//! protocol. `ftp.rs`/`sftp.rs` never open a `TcpStream` themselves.
//!
//! Without a configured proxy, `connect()` is a thin wrapper around
//! `TcpStream::connect` — behavior for users who never touch the proxy
//! setting is unchanged from before this module existed.

use super::proxy;
use crate::store::JsonMap;
use anyhow::Context;
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    Socks4,
    Socks5,
    Http,
}

/// Global proxy settings, resolved once per connect attempt. Constructed
/// from the same connect-time config map `ftp.rs`/`sftp.rs::connect()`
/// already receive — `commands/session.rs::session_connect` merges these
/// fields in from `settings.json` (via `Store::proxy_config_for_connect`)
/// before any backend's `connect()` runs, so this is global state riding
/// through the per-connect config, not a per-site/per-connection setting.
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxyConfig {
    pub fn from_json_map(config: &JsonMap) -> anyhow::Result<Option<Self>> {
        let enabled = config
            .get("proxyEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !enabled {
            return Ok(None);
        }
        let host = config
            .get("proxyHost")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .context("proxyHost is required when proxy is enabled")?
            .to_string();
        let port = config
            .get("proxyPort")
            .and_then(|v| v.as_u64())
            .context("proxyPort is required when proxy is enabled")?;
        let port = u16::try_from(port).context("proxyPort is out of range")?;
        let kind = match config.get("proxyType").and_then(|v| v.as_str()) {
            Some("socks4") => ProxyKind::Socks4,
            Some("http") => ProxyKind::Http,
            _ => ProxyKind::Socks5,
        };
        let username = config
            .get("proxyUsername")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let password = config
            .get("proxyPassword")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        Ok(Some(Self {
            kind,
            host,
            port,
            username,
            password,
        }))
    }
}

/// Opens a TCP connection to `target_host:target_port`, transparently
/// tunneling through `proxy` when given. Returns the raw stream ready for
/// the caller's own protocol handshake (FTP/FTPS/SSH) — no proxy-protocol
/// bytes remain unread on it after this returns `Ok`.
///
/// `target_host` is passed through as a hostname whenever possible (never
/// pre-resolved by this process) so a configured proxy can do its own DNS
/// resolution — the whole point of routing through it in the first place
/// on a network where only the proxy has outbound DNS/connectivity.
pub async fn connect(
    target_host: &str,
    target_port: u16,
    proxy_cfg: Option<&ProxyConfig>,
) -> anyhow::Result<TcpStream> {
    let Some(cfg) = proxy_cfg else {
        return TcpStream::connect((target_host, target_port))
            .await
            .with_context(|| format!("could not connect to {target_host}:{target_port}"));
    };

    let mut stream = TcpStream::connect((cfg.host.as_str(), cfg.port))
        .await
        .with_context(|| format!("could not connect to proxy {}:{}", cfg.host, cfg.port))?;

    match cfg.kind {
        ProxyKind::Socks4 => {
            proxy::socks4_handshake(
                &mut stream,
                target_host,
                target_port,
                cfg.username.as_deref(),
            )
            .await
            .context("SOCKS4 proxy handshake failed")?;
        }
        ProxyKind::Socks5 => {
            proxy::socks5_handshake(
                &mut stream,
                target_host,
                target_port,
                cfg.username.as_deref(),
                cfg.password.as_deref(),
            )
            .await
            .context("SOCKS5 proxy handshake failed")?;
        }
        ProxyKind::Http => {
            proxy::http_connect_handshake(
                &mut stream,
                target_host,
                target_port,
                cfg.username.as_deref(),
                cfg.password.as_deref(),
            )
            .await
            .context("HTTP CONNECT proxy handshake failed")?;
        }
    }

    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn from_json_map_is_none_when_disabled_or_absent() {
        assert!(
            ProxyConfig::from_json_map(&Default::default())
                .unwrap()
                .is_none()
        );
        let config = json!({"proxyEnabled": false, "proxyHost": "proxy.local", "proxyPort": 1080})
            .as_object()
            .unwrap()
            .clone();
        assert!(ProxyConfig::from_json_map(&config).unwrap().is_none());
    }

    #[test]
    fn from_json_map_parses_full_config() {
        let config = json!({
            "proxyEnabled": true,
            "proxyType": "http",
            "proxyHost": "proxy.local",
            "proxyPort": 8080,
            "proxyUsername": "alice",
            "proxyPassword": "s3cret",
        })
        .as_object()
        .unwrap()
        .clone();
        let cfg = ProxyConfig::from_json_map(&config)
            .unwrap()
            .expect("should parse");
        assert_eq!(cfg.kind, ProxyKind::Http);
        assert_eq!(cfg.host, "proxy.local");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.username.as_deref(), Some("alice"));
        assert_eq!(cfg.password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn from_json_map_defaults_type_to_socks5() {
        let config = json!({"proxyEnabled": true, "proxyHost": "proxy.local", "proxyPort": 1080})
            .as_object()
            .unwrap()
            .clone();
        let cfg = ProxyConfig::from_json_map(&config)
            .unwrap()
            .expect("should parse");
        assert_eq!(cfg.kind, ProxyKind::Socks5);
    }

    #[test]
    fn from_json_map_requires_host_and_port() {
        let missing_host = json!({"proxyEnabled": true, "proxyPort": 1080})
            .as_object()
            .unwrap()
            .clone();
        assert!(ProxyConfig::from_json_map(&missing_host).is_err());
        let missing_port = json!({"proxyEnabled": true, "proxyHost": "proxy.local"})
            .as_object()
            .unwrap()
            .clone();
        assert!(ProxyConfig::from_json_map(&missing_port).is_err());
    }

    #[tokio::test]
    async fn connect_without_proxy_dials_target_directly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accept_task = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
        });
        connect(&addr.ip().to_string(), addr.port(), None)
            .await
            .expect("direct connect should succeed");
        accept_task.await.unwrap();
    }

    #[tokio::test]
    async fn connect_without_proxy_supports_ipv6_when_loopback_is_available() {
        let Ok(listener) = tokio::net::TcpListener::bind("[::1]:0").await else {
            return; // IPv6 can be disabled on a CI host.
        };
        let port = listener.local_addr().unwrap().port();
        let accept_task = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
        });
        if connect("::1", port, None).await.is_err() {
            accept_task.abort();
            return;
        }
        accept_task.await.unwrap();
    }
}
