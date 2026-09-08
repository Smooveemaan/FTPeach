//! Hand-rolled SOCKS4/4a, SOCKS5, and HTTP CONNECT handshakes over an
//! already-connected `tokio::net::TcpStream` — see transport.rs for how
//! this gets dialed. All three are written by hand rather than pulled in
//! from a crate:
//!
//! - `suppaftp::connect_with_stream()` requires a literal `TcpStream`, not
//!   a generic `AsyncRead + AsyncWrite` — a wrapper crate like `tokio-socks`
//!   would hand back its own `Socks5Stream<T>` instead of the original
//!   `TcpStream`, which doesn't fit.
//! - The `async-http-proxy` crate is unsuitable for HTTP CONNECT here:
//!   it reads the response through its own function-local
//!   `tokio::io::BufStream`, which is dropped (buffer and all) the moment
//!   the function returns. If a single `read()` inside that buffer happens
//!   to pull in both the proxy's response *and* the first bytes the target
//!   already sent — a real race here, not a hypothetical one: FTP and SSH
//!   servers both send an unsolicited banner the instant they accept a
//!   connection, before waiting for anything from the client — those bytes
//!   are silently lost. Every read below is either a fixed-size
//!   `read_exact` or an explicit byte-at-a-time scan for the terminator,
//!   so nothing is ever buffered past what the handshake itself consumes.
//!
//! Every function here leaves the stream positioned exactly at the first
//! byte of the tunneled protocol (FTP banner, SSH identification string,
//! TLS ServerHello) on success — no proxy-protocol bytes left unread, none
//! over-read either.

use anyhow::{Context, Result, bail};
use std::net::{IpAddr, Ipv4Addr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

// ---------- SOCKS4 / SOCKS4a ----------

/// Sends a CONNECT request. Uses plain SOCKS4 (binary IPv4 in the request)
/// when `target_host` already is a literal IPv4 address, SOCKS4a (the
/// `0.0.0.x` sentinel + trailing hostname) otherwise — no separate UI
/// toggle, this is chosen automatically per-connection.
pub async fn socks4_handshake(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: Option<&str>,
) -> Result<()> {
    if target_host.parse::<std::net::Ipv6Addr>().is_ok() {
        bail!("SOCKS4 cannot connect to an IPv6 address; use SOCKS5 or HTTP CONNECT");
    }
    let literal_ip = target_host.parse::<Ipv4Addr>().ok();

    let mut req = Vec::with_capacity(32 + target_host.len());
    req.push(0x04); // VN: SOCKS version 4
    req.push(0x01); // CD: CONNECT
    req.extend_from_slice(&target_port.to_be_bytes());
    match literal_ip {
        Some(ip) => req.extend_from_slice(&ip.octets()),
        // SOCKS4a: a non-zero last octet with the first three zero tells
        // the proxy the real address follows as a hostname at the end.
        None => req.extend_from_slice(&[0, 0, 0, 1]),
    }
    req.extend_from_slice(username.unwrap_or("").as_bytes());
    req.push(0x00); // NUL-terminates USERID
    if literal_ip.is_none() {
        req.extend_from_slice(target_host.as_bytes());
        req.push(0x00); // NUL-terminates the SOCKS4a hostname
    }
    stream
        .write_all(&req)
        .await
        .context("writing SOCKS4 CONNECT request")?;

    let mut resp = [0u8; 8];
    stream
        .read_exact(&mut resp)
        .await
        .context("reading SOCKS4 response")?;
    if resp[0] != 0x00 {
        bail!("SOCKS4 proxy sent an invalid response (bad VN byte)");
    }
    match resp[1] {
        0x5a => Ok(()),
        0x5b => bail!("SOCKS4 proxy rejected the connection"),
        0x5c => bail!("SOCKS4 proxy rejected the connection: client is not running identd"),
        0x5d => bail!("SOCKS4 proxy rejected the connection: identd could not confirm the user"),
        code => bail!("SOCKS4 proxy returned an unexpected status code ({code})"),
    }
}

// ---------- SOCKS5 ----------

/// Negotiates auth (NO AUTH, or NO AUTH + USERNAME/PASSWORD when
/// credentials are configured) and issues a CONNECT request. The target
/// Hostnames go over as ATYP=DOMAINNAME so the proxy performs DNS. Literal
/// IPv4/IPv6 targets use their native address type, which is required by RFC
/// 1928 and avoids treating an IPv6 literal as an invalid DNS name.
pub async fn socks5_handshake(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<()> {
    let creds = match (username, password) {
        (Some(u), Some(p)) if !u.is_empty() => Some((u, p)),
        _ => None,
    };

    let methods: &[u8] = if creds.is_some() {
        &[0x00, 0x02]
    } else {
        &[0x00]
    };
    let mut greeting = Vec::with_capacity(2 + methods.len());
    greeting.push(0x05); // SOCKS version 5
    greeting.push(methods.len() as u8);
    greeting.extend_from_slice(methods);
    stream
        .write_all(&greeting)
        .await
        .context("writing SOCKS5 greeting")?;

    let mut method_resp = [0u8; 2];
    stream
        .read_exact(&mut method_resp)
        .await
        .context("reading SOCKS5 method selection")?;
    if method_resp[0] != 0x05 {
        bail!("SOCKS5 proxy returned an unexpected protocol version");
    }
    match method_resp[1] {
        0x00 => {}
        0x02 => {
            let (user, pass) = creds
                .context("SOCKS5 proxy demands username/password auth but none is configured")?;
            if user.len() > 255 || pass.len() > 255 {
                bail!("SOCKS5 username/password must each be at most 255 bytes");
            }
            let mut auth_req = Vec::with_capacity(3 + user.len() + pass.len());
            auth_req.push(0x01); // auth sub-negotiation version
            auth_req.push(user.len() as u8);
            auth_req.extend_from_slice(user.as_bytes());
            auth_req.push(pass.len() as u8);
            auth_req.extend_from_slice(pass.as_bytes());
            stream
                .write_all(&auth_req)
                .await
                .context("writing SOCKS5 username/password auth request")?;

            let mut auth_resp = [0u8; 2];
            stream
                .read_exact(&mut auth_resp)
                .await
                .context("reading SOCKS5 auth response")?;
            if auth_resp[1] != 0x00 {
                bail!("SOCKS5 proxy authentication failed");
            }
        }
        0xff => bail!("SOCKS5 proxy rejected every offered authentication method"),
        other => bail!("SOCKS5 proxy selected an unsupported authentication method ({other})"),
    }

    let target = target_host.parse::<IpAddr>().ok();
    if target.is_none() && target_host.len() > 255 {
        bail!("target hostname is too long for SOCKS5 (max 255 bytes)");
    }
    let mut req = Vec::with_capacity(7 + target_host.len());
    req.push(0x05); // SOCKS version 5
    req.push(0x01); // CMD: CONNECT
    req.push(0x00); // RSV
    match target {
        Some(IpAddr::V4(ip)) => {
            req.push(0x01); // ATYP: IPv4
            req.extend_from_slice(&ip.octets());
        }
        Some(IpAddr::V6(ip)) => {
            req.push(0x04); // ATYP: IPv6
            req.extend_from_slice(&ip.octets());
        }
        None => {
            req.push(0x03); // ATYP: DOMAINNAME
            req.push(target_host.len() as u8);
            req.extend_from_slice(target_host.as_bytes());
        }
    }
    req.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&req)
        .await
        .context("writing SOCKS5 CONNECT request")?;

    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .context("reading SOCKS5 CONNECT reply")?;
    if head[0] != 0x05 {
        bail!("SOCKS5 proxy returned an unexpected protocol version in its CONNECT reply");
    }
    if head[1] != 0x00 {
        bail!(socks5_reply_error(head[1]));
    }
    match head[3] {
        0x01 => drain_exact(stream, 4 + 2).await?,  // IPv4 + port
        0x04 => drain_exact(stream, 16 + 2).await?, // IPv6 + port
        0x03 => {
            let mut len_buf = [0u8; 1];
            stream
                .read_exact(&mut len_buf)
                .await
                .context("reading SOCKS5 bound-address domain length")?;
            drain_exact(stream, len_buf[0] as usize + 2).await?;
        }
        atyp => {
            bail!("SOCKS5 proxy returned an unknown address type ({atyp}) in its CONNECT reply")
        }
    }
    Ok(())
}

async fn drain_exact(stream: &mut TcpStream, len: usize) -> Result<()> {
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .context("reading SOCKS5 bound address")?;
    Ok(())
}

fn socks5_reply_error(code: u8) -> String {
    match code {
        0x01 => "SOCKS5 proxy: general server failure".to_string(),
        0x02 => "SOCKS5 proxy: connection not allowed by ruleset".to_string(),
        0x03 => "SOCKS5 proxy: network unreachable".to_string(),
        0x04 => "SOCKS5 proxy: host unreachable".to_string(),
        0x05 => "SOCKS5 proxy rejected the connection".to_string(),
        0x06 => "SOCKS5 proxy: TTL expired".to_string(),
        0x07 => "SOCKS5 proxy: command not supported".to_string(),
        0x08 => "SOCKS5 proxy: address type not supported".to_string(),
        code => format!("SOCKS5 proxy returned an unexpected error code ({code})"),
    }
}

// ---------- HTTP CONNECT ----------

/// Caps how much of the proxy's response header this will read before
/// giving up — a misbehaving proxy that never sends a blank line must not
/// be allowed to make this buffer grow unbounded.
const MAX_HTTP_PROXY_HEADER: usize = 16 * 1024;

/// Sends `CONNECT host:port HTTP/1.1` (with `Proxy-Authorization: Basic`
/// when credentials are configured) and reads the response strictly up to
/// the blank line that ends the headers — one byte at a time, no
/// `BufReader`/`BufStream` — so nothing beyond the header is ever pulled
/// off the wire. See this module's doc comment for why that matters here.
pub async fn http_connect_handshake(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<()> {
    let authority = if target_host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{target_host}]:{target_port}")
    } else {
        format!("{target_host}:{target_port}")
    };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let (Some(user), Some(pass)) = (username, password)
        && !user.is_empty()
    {
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD as base64_standard;
        let token = base64_standard.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("Proxy-Connection: keep-alive\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .context("writing HTTP CONNECT request")?;

    let header = read_http_header(stream).await?;
    let status = parse_http_status(&header)?;
    if !(200..300).contains(&status) {
        bail!("HTTP CONNECT proxy rejected the request (status {status})");
    }
    Ok(())
}

/// Reads exactly up to and including the `\r\n\r\n` that ends the response
/// headers, one byte at a time — guarantees no byte belonging to the
/// tunneled protocol that follows is ever consumed.
async fn read_http_header(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut header = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        if header.len() >= MAX_HTTP_PROXY_HEADER {
            bail!("HTTP CONNECT proxy response header exceeded {MAX_HTTP_PROXY_HEADER} bytes");
        }
        let n = stream
            .read(&mut byte)
            .await
            .context("reading HTTP CONNECT proxy response")?;
        if n == 0 {
            bail!("HTTP CONNECT proxy closed the connection before sending a full response");
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            return Ok(header);
        }
    }
}

fn parse_http_status(header: &[u8]) -> Result<u16> {
    let text = String::from_utf8_lossy(header);
    let status_line = text
        .lines()
        .next()
        .filter(|l| !l.is_empty())
        .context("HTTP CONNECT proxy response is missing a status line")?;
    // "HTTP/1.1 200 Connection Established" — status code is the second
    // whitespace-delimited token.
    let code = status_line
        .split_whitespace()
        .nth(1)
        .context("HTTP CONNECT proxy response is missing a status code")?;
    code.parse::<u16>()
        .with_context(|| format!("HTTP CONNECT proxy sent a non-numeric status code: {code:?}"))
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
