//! FTP servers that name files in a code page other than UTF-8.
//!
//! suppaftp writes every command as UTF-8 and reads replies as UTF-8, so a
//! session in another encoding runs its control connection through a relay on
//! the loopback interface. The relay converts line by line: commands from
//! UTF-8 into the server's encoding, replies back into UTF-8. TLS has to sit
//! between the relay and the server, so the relay secures the connection
//! itself before suppaftp sees it.

use anyhow::{Context, Result, anyhow};
use encoding_rs::Encoding;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;
use suppaftp::Status;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// The longest control line relayed in one piece.
const MAX_LINE: u64 = 64 * 1024;
const LOOPBACK_ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);

/// What the relay answers, in place of the server, to a command naming a
/// file the server's encoding has no characters for.
pub const UNENCODABLE_REPLY: &str = "553 FTPeach: the name has characters the site encoding lacks";

/// The encoding a site's `encoding` setting names. Empty, and UTF-8 itself,
/// mean no relay. Only encodings that keep ASCII as it is can carry FTP
/// commands.
pub fn parse(label: &str) -> Result<Option<&'static Encoding>> {
    if label.is_empty() {
        return Ok(None);
    }
    let encoding = Encoding::for_label(label.as_bytes())
        .filter(|encoding| encoding.is_ascii_compatible())
        .ok_or_else(|| anyhow!("unsupported FTP encoding: {label}"))?;
    Ok((encoding != encoding_rs::UTF_8).then_some(encoding))
}

/// A listing's text, in whatever encoding the session uses.
pub fn decode(encoding: Option<&'static Encoding>, bytes: &[u8]) -> String {
    match encoding {
        Some(encoding) => encoding.decode_without_bom_handling(bytes).0.into_owned(),
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

trait ServerStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ServerStream for T {}

/// Starts relaying `server` in `encoding`, answering with the loopback
/// connection to hand suppaftp in its place. With `tls`, the relay reads the
/// greeting, asks for AUTH TLS and completes the handshake first; suppaftp
/// then reads that same greeting, and PBSZ and PROT are left to the caller.
pub async fn start(
    server: TcpStream,
    encoding: &'static Encoding,
    tls: Option<(
        tokio_rustls::TlsConnector,
        rustls_pki_types::ServerName<'static>,
    )>,
) -> Result<TcpStream> {
    let local = server.local_addr()?;
    let (server, greeting): (Box<dyn ServerStream>, Vec<u8>) = match tls {
        None => (Box::new(server), Vec::new()),
        Some((connector, name)) => {
            let mut reader = BufReader::new(server);
            let greeting = read_reply(&mut reader).await?;
            expect(&greeting, Status::Ready)?;
            reader.get_mut().write_all(b"AUTH TLS\r\n").await?;
            let auth = read_reply(&mut reader).await?;
            expect(&auth, Status::AuthOk)?;
            anyhow::ensure!(
                reader.buffer().is_empty(),
                "the server sent more after agreeing to TLS"
            );
            let tls = connector
                .connect(name, reader.into_inner())
                .await
                .context("TLS handshake failed")?;
            (Box::new(tls), greeting)
        }
    };
    let (client, relay_end) = loopback_pair().await?;
    tokio::spawn(relay(server, relay_end, encoding, greeting, local.ip()));
    Ok(client)
}

/// A connected loopback pair. Any local program could connect to the
/// listener first, so only the connection from our own socket is taken.
async fn loopback_pair() -> Result<(TcpStream, TcpStream)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let client = TcpStream::connect(listener.local_addr()?).await?;
    let ours = client.local_addr()?;
    let accepted = tokio::time::timeout(LOOPBACK_ACCEPT_TIMEOUT, async {
        loop {
            let (stream, from) = listener.accept().await?;
            if from == ours {
                return anyhow::Ok(stream);
            }
        }
    })
    .await
    .context("the FTP encoding relay did not connect")??;
    client.set_nodelay(true)?;
    accepted.set_nodelay(true)?;
    Ok((client, accepted))
}

async fn relay(
    server: Box<dyn ServerStream>,
    client: TcpStream,
    encoding: &'static Encoding,
    greeting: Vec<u8>,
    local: IpAddr,
) {
    let (server_read, mut server_write) = tokio::io::split(server);
    let (client_read, client_write) = client.into_split();
    let client_write = Arc::new(Mutex::new(client_write));
    let replies = {
        let client_write = client_write.clone();
        async move {
            let mut reader = BufReader::new(server_read);
            let mut line = greeting;
            loop {
                if line.is_empty() && read_line(&mut reader, &mut line).await? == 0 {
                    return anyhow::Ok(());
                }
                let text = encoding.decode_without_bom_handling(&line).0;
                client_write.lock().await.write_all(text.as_bytes()).await?;
                line.clear();
            }
        }
    };
    let commands = async move {
        let mut reader = BufReader::new(client_read);
        let mut line = Vec::new();
        loop {
            line.clear();
            if read_line(&mut reader, &mut line).await? == 0 {
                return anyhow::Ok(());
            }
            let text = String::from_utf8_lossy(&line);
            let text = active_address(&text, local).unwrap_or_else(|| text.into_owned());
            let (bytes, _, unmappable) = encoding.encode(&text);
            if unmappable {
                let reply = format!("{UNENCODABLE_REPLY}\r\n");
                client_write
                    .lock()
                    .await
                    .write_all(reply.as_bytes())
                    .await?;
                continue;
            }
            server_write.write_all(&bytes).await?;
        }
    };
    // Either side closing ends the session; dropping both streams closes
    // the other.
    tokio::select! {
        _ = replies => {}
        _ = commands => {}
    }
}

async fn read_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
) -> std::io::Result<usize> {
    reader.take(MAX_LINE).read_until(b'\n', line).await
}

/// suppaftp names the address of its active-mode listener from the control
/// connection, which is the loopback one here. The server has to be given
/// the address the real connection leaves from.
fn active_address(command: &str, local: IpAddr) -> Option<String> {
    let port = if let Some(argument) = command.strip_prefix("PORT ") {
        let numbers: Vec<u16> = argument
            .trim_end()
            .split(',')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        match numbers[..] {
            [_, _, _, _, high, low] if high < 256 && low < 256 => high << 8 | low,
            _ => return None,
        }
    } else if let Some(argument) = command.strip_prefix("EPRT ") {
        let argument = argument.trim_end();
        let delimiter = argument.chars().next()?;
        argument.split(delimiter).nth(3)?.parse().ok()?
    } else {
        return None;
    };
    Some(match local {
        IpAddr::V4(ip) => {
            let [a, b, c, d] = ip.octets();
            format!("PORT {a},{b},{c},{d},{},{}\r\n", port >> 8, port & 0xff)
        }
        IpAddr::V6(ip) => format!("EPRT |2|{ip}|{port}|\r\n"),
    })
}

/// One whole reply, as suppaftp reads it: lines up to the first that starts
/// with a code and a space.
async fn read_reply(reader: &mut BufReader<TcpStream>) -> Result<Vec<u8>> {
    let mut reply = Vec::new();
    loop {
        let start = reply.len();
        if read_line(reader, &mut reply).await? == 0 {
            return Err(anyhow!("the server closed the connection"));
        }
        let line = &reply[start..];
        if line.len() >= 4 && line[..3].iter().all(u8::is_ascii_digit) && line[3] == b' ' {
            return Ok(reply);
        }
    }
}

fn expect(reply: &[u8], status: Status) -> Result<()> {
    let code = std::str::from_utf8(&reply[..3])
        .ok()
        .and_then(|code| code.parse::<u32>().ok())
        .unwrap_or_default();
    if code == status.code() {
        return Ok(());
    }
    Err(
        suppaftp::FtpError::UnexpectedResponse(suppaftp::types::Response::new(
            Status::from(code),
            reply.to_vec(),
        ))
        .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ascii_compatible_encodings_other_than_utf8_are_relayed() {
        assert_eq!(parse("").unwrap(), None);
        assert_eq!(parse("utf-8").unwrap(), None);
        assert_eq!(
            parse("windows-1251").unwrap(),
            Some(encoding_rs::WINDOWS_1251)
        );
        assert_eq!(parse("Shift_JIS").unwrap(), Some(encoding_rs::SHIFT_JIS));
        assert!(parse("utf-16le").is_err());
        assert!(parse("iso-2022-jp").is_err());
        assert!(parse("no-such-encoding").is_err());
    }

    #[test]
    fn active_mode_names_the_real_local_address() {
        let v4 = IpAddr::from([192, 168, 1, 20]);
        assert_eq!(
            active_address("PORT 127,0,0,1,195,80\r\n", v4).as_deref(),
            Some("PORT 192,168,1,20,195,80\r\n")
        );
        assert_eq!(
            active_address("EPRT |1|127.0.0.1|50000|\r\n", v4).as_deref(),
            Some("PORT 192,168,1,20,195,80\r\n")
        );
        let v6: IpAddr = "2001:db8::5".parse().unwrap();
        assert_eq!(
            active_address("PORT 127,0,0,1,195,80\r\n", v6).as_deref(),
            Some("EPRT |2|2001:db8::5|50000|\r\n")
        );
        assert_eq!(active_address("RETR PORT 1,2\r\n", v4), None);
        assert_eq!(active_address("PORT 1,2,3\r\n", v4), None);
    }

    #[tokio::test]
    async fn names_cross_the_relay_in_the_server_encoding() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        let fake = tokio::spawn(async move {
            let (mut stream, _) = server.accept().await.unwrap();
            stream.write_all(b"220 ready\r\n").await.unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut command = Vec::new();
            reader.read_until(b'\n', &mut command).await.unwrap();
            // A Cyrillic name in windows-1251.
            stream
                .write_all(b"550 /\xce\xf2\xf7\xe5\xf2: no such file\r\n")
                .await
                .unwrap();
            // Kept open: the relay ends with either side.
            (command, stream)
        });
        let tcp = TcpStream::connect(address).await.unwrap();
        let client = start(tcp, encoding_rs::WINDOWS_1251, None).await.unwrap();
        let mut client = BufReader::new(client);
        let mut line = String::new();
        client.read_line(&mut line).await.unwrap();
        assert_eq!(line, "220 ready\r\n");

        let name = "\u{41e}\u{442}\u{447}\u{435}\u{442}";
        client
            .get_mut()
            .write_all(format!("DELE /{name}\r\n").as_bytes())
            .await
            .unwrap();
        line.clear();
        client.read_line(&mut line).await.unwrap();
        assert_eq!(line, format!("550 /{name}: no such file\r\n"));
        let (command, _server) = fake.await.unwrap();
        assert_eq!(command, b"DELE /\xce\xf2\xf7\xe5\xf2\r\n");

        // No server round trip for a name the encoding cannot hold.
        client
            .get_mut()
            .write_all("DELE /\u{65e5}\u{672c}\r\n".as_bytes())
            .await
            .unwrap();
        line.clear();
        client.read_line(&mut line).await.unwrap();
        assert_eq!(line, format!("{UNENCODABLE_REPLY}\r\n"));
    }
}
