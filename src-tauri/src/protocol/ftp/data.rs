//! Data connections: how a transfer's or a listing's data connection is opened,
//! read, and settled with the server, passive or active.
use super::*;

/// Preliminary replies that open a download's or an upload's data transfer.
pub(super) const RETRIEVE_OPEN: &[Status] = &[Status::AboutToSend, Status::AlreadyOpen];
pub(super) const STORE_OPEN: &[Status] = &[Status::AlreadyOpen, Status::AboutToSend];
pub(super) async fn read_list_data(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    idle: Duration,
) -> BackendResult<Vec<u8>> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let mut entries = 0;
    loop {
        let n = tokio::time::timeout(idle, reader.read(&mut buf))
            .await
            .map_err(|_| crate::protocol::fail(ErrorCode::TimedOut, "FTP LIST data stalled"))??;
        if n == 0 {
            return Ok(raw);
        }
        entries += buf[..n].iter().filter(|&&b| b == b'\n').count();
        if raw.len().saturating_add(n) > crate::protocol::MAX_DIRECTORY_TEXT_BYTES
            || entries > crate::protocol::MAX_RAW_DIRECTORY_ENTRIES
        {
            return Err(crate::protocol::fail(
                ErrorCode::ResourceLimit,
                "FTP LIST exceeds its byte or entry budget",
            ));
        }
        raw.extend_from_slice(&buf[..n]);
    }
}
/// A STOR's data connection, reset rather than closed if it goes before the
/// upload finished — the pool cancelling it, most of all. A plain close lets
/// the kernel go on delivering whatever was still queued, which the server
/// takes as the rest of the file: it keeps writing it after the stop, and
/// answers nothing on the control connection, QUIT included, until the last
/// byte is in.
pub(super) struct UploadData(pub(super) Option<Data>);

impl UploadData {
    pub(super) fn stream(&mut self) -> &mut AsyncDataStream<AsyncRustlsStream> {
        self.0
            .as_mut()
            .expect("upload data connection already handed over")
            .stream()
    }

    /// Ends the upload the ordinary way, once the whole file is written: the
    /// FIN goes out behind the last byte, then the server confirms the file.
    /// Until it has, dropping this still resets the connection, so a stop
    /// that lands while the last bytes are in flight still takes effect.
    pub(super) async fn finish(mut self, control: &mut AsyncRustlsFtpStream) -> BackendResult<()> {
        tokio::time::timeout(TRANSFER_STALL_TIMEOUT, self.stream().shutdown())
            .await
            .context("upload shutdown timed out")?
            .context("closing the upload data connection")?;
        // The data connection is already shut; this only reads the verdict.
        // An active one is closed before suppaftp reads it, so a stop from
        // here on finds that connection closed rather than reset.
        let verdict = async {
            match self.0.take_if(|data| matches!(data, Data::Active(_))) {
                Some(active) => active.settle(control).await,
                None => control.read_response_in(TRANSFER_SETTLED).await.map(drop),
            }
        };
        tokio::time::timeout(TRANSFER_STALL_TIMEOUT, verdict)
            .await
            .context("upload completion timed out")??;
        // The server has the whole file, so closing takes nothing back now.
        self.0 = None;
        Ok(())
    }
}

impl Drop for UploadData {
    fn drop(&mut self) {
        if let Some(data) = &self.0 {
            let _ = data.socket().set_zero_linger();
        }
    }
}

/// The replies that confirm a transfer once its data connection has closed.
pub(super) const TRANSFER_SETTLED: &[Status] =
    &[Status::ClosingDataConnection, Status::RequestedFileActionOk];

/// A transfer's data connection. A passive one is opened by `DataChannel`.
/// An active one is suppaftp's: it accepts the connection from the server
/// and reads the server's verdict on the transfer itself.
pub(super) enum Data {
    Passive(AsyncDataStream<AsyncRustlsStream>),
    Active(TransferStream<AsyncRustlsStream>),
}

impl Data {
    pub(super) fn stream(&mut self) -> &mut AsyncDataStream<AsyncRustlsStream> {
        match self {
            Self::Passive(stream) => stream,
            Self::Active(transfer) => transfer.get_mut(),
        }
    }

    pub(super) fn socket(&self) -> &tokio::net::TcpStream {
        match self {
            Self::Passive(stream) => stream.get_ref(),
            Self::Active(transfer) => transfer.get_ref().get_ref(),
        }
    }

    /// Closes the data connection, which is what makes the server answer,
    /// and reads its verdict on the transfer.
    pub(super) async fn settle(
        self,
        control: &mut AsyncRustlsFtpStream,
    ) -> suppaftp::FtpResult<()> {
        match self {
            Self::Passive(stream) => {
                drop(stream);
                control.read_response_in(TRANSFER_SETTLED).await.map(drop)
            }
            Self::Active(transfer) => transfer.finish().await,
        }
    }

    /// The same once a download has been read to its end: the TLS
    /// close_notify goes out first. The verdict stands whatever closing a
    /// connection that was read to its end reports.
    pub(super) async fn settle_download(
        mut self,
        control: &mut AsyncRustlsFtpStream,
    ) -> suppaftp::FtpResult<()> {
        let _ = self.stream().shutdown().await;
        self.settle(control).await
    }
}
/// How many times a passive port is asked for before a 425 is the answer.
pub(super) const PASSIVE_PORT_ATTEMPTS: usize = 3;

/// Whether the server said it could not open the data port it picked.
pub(super) fn passive_port_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<suppaftp::FtpError>(),
            Some(suppaftp::FtpError::UnexpectedResponse(response))
                if response.status == Status::CannotOpenDataConnection
        )
    })
}
/// The port in a `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)` reply. The
/// address is not used: data goes to the control connection's peer.
pub(super) fn pasv_port(reply: &str) -> Option<u16> {
    reply
        .get(4..)?
        .split(|c: char| !c.is_ascii_digit() && c != ',')
        .find_map(|group| {
            let numbers = group
                .split(',')
                .map(str::parse::<u8>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            match numbers[..] {
                [_, _, _, _, high, low] => Some(u16::from(high) << 8 | u16::from(low)),
                _ => None,
            }
        })
}

/// The port in a `229 Entering Extended Passive Mode (|||port|)` reply, whose
/// delimiter is whatever character follows the parenthesis.
pub(super) fn epsv_port(reply: &str) -> Option<u16> {
    let inner = &reply[reply.find('(')? + 1..];
    let delimiter = inner.chars().next()?;
    inner.split(delimiter).nth(3)?.parse().ok()
}
/// Opens the data connections of one control connection.
///
/// suppaftp starts the TLS handshake on a passive data connection before it
/// reads the reply to the command that asked for it. When that reply is a
/// refusal (RETR of a missing file, MLSD of a folder that may not be read) no
/// one answers the handshake, and the operation hung until it timed out. The
/// handshake here runs alongside the wait for the reply, so a refusal ends it.
#[derive(Clone)]
pub(super) struct DataChannel {
    /// Where a proxy connects data connections to. Direct ones go to the
    /// control connection's peer, whatever address PASV names: behind NAT it
    /// is often a private one.
    pub(super) host: String,
    pub(super) proxy: Option<crate::protocol::transport::ProxyConfig>,
    /// Built from the control connection's own TLS settings, whose session
    /// cache lets the data connection resume that session.
    pub(super) tls: Option<(tokio_rustls::TlsConnector, ServerName<'static>)>,
    pub(super) tickets: Arc<SessionTickets>,
    /// The server's address. The control connection's own peer is the
    /// loopback relay when the site has an encoding.
    pub(super) peer: std::net::IpAddr,
    pub(super) encoding: Option<&'static encoding_rs::Encoding>,
    pub(super) active: bool,
    /// EPSV instead of PASV: over IPv6, or once the server turned PASV away.
    pub(super) extended: Arc<AtomicBool>,
}

impl DataChannel {
    pub(super) async fn open(
        &self,
        control: &mut AsyncRustlsFtpStream,
        command: String,
        expected: &[Status],
    ) -> BackendResult<Data> {
        if self.active {
            return match control.custom_data_command(command, expected).await {
                Ok((_, stream)) => Ok(Data::Active(stream)),
                Err(suppaftp::FtpError::UnexpectedResponse(response))
                    if active_mode_refused(&response) =>
                {
                    Err(crate::protocol::fail(
                        ErrorCode::ActiveModeFailed,
                        format!(
                            "Active mode failed: {}",
                            String::from_utf8_lossy(&response.body).trim()
                        ),
                    ))
                }
                Err(error) => Err(error.into()),
            };
        }
        let port = self.passive_port(control).await?;
        let peer = self.peer;
        let connect = async {
            match &self.proxy {
                Some(proxy) => {
                    crate::protocol::transport::connect(&self.host, port, Some(proxy)).await
                }
                None => tokio::net::TcpStream::connect((peer, port))
                    .await
                    .with_context(|| format!("could not connect to {peer}:{port}")),
            }
        };
        let tcp = tokio::time::timeout(TRANSFER_STALL_TIMEOUT, connect)
            .await
            .context("FTP data connection timed out")?
            .context("opening the FTP data connection")?;
        let Some((connector, name)) = self.tls.clone() else {
            control.custom_command(command, expected).await?;
            return Ok(Data::Passive(AsyncDataStream::Tcp(tcp)));
        };
        let upload = command.starts_with("STOR ") || command.starts_with("APPE ");
        // tokio-rustls builds the TLS connection, spending a session ticket,
        // as soon as `connect` is called; the async block defers that until
        // the handshake is really started.
        let handshake = async move { connector.connect(name, tcp).await };
        tokio::pin!(handshake);
        let reply = control.custom_command(command, expected);
        tokio::pin!(reply);
        let mut secured = None;
        // Most servers reply before they take the handshake, and starting it
        // spends a session ticket even when the reply turns out a refusal.
        // A server that wants the handshake first gets it after a moment.
        let early = tokio::select! {
            reply = &mut reply => Some(reply),
            _ = tokio::time::sleep(HANDSHAKE_FIRST_WAIT) => None,
        };
        // Servers differ on whether the reply or the handshake comes first.
        let reply = match early {
            Some(reply) => reply,
            None => loop {
                tokio::select! {
                    reply = &mut reply => break reply,
                    done = &mut handshake, if secured.is_none() => secured = Some(done),
                }
            },
        };
        // A refusal drops the handshake that is still waiting for an answer.
        reply?;
        let tls = match secured {
            Some(done) => done,
            None => tokio::time::timeout(TRANSFER_STALL_TIMEOUT, handshake)
                .await
                .context("FTP data TLS handshake timed out")?,
        }
        .context("TLS handshake failed on the FTP data connection")?;
        let mut tls = tls;
        if upload {
            self.tickets.replenish(&mut tls).await;
        }
        Ok(Data::Passive(AsyncDataStream::Ssl(Box::new(
            AsyncRustlsStream::from(tls),
        ))))
    }

    /// Asks for a passive port, again when the server could not open the one
    /// it picked (425). Pure-FTPd answers that when two of its sessions pick
    /// the same port at the same moment, which parallel transfers make likely
    /// on a narrow port range; asked again, it picks another.
    pub(super) async fn passive_port(
        &self,
        control: &mut AsyncRustlsFtpStream,
    ) -> BackendResult<u16> {
        let mut attempts_left = PASSIVE_PORT_ATTEMPTS;
        loop {
            attempts_left -= 1;
            match self.ask_passive_port(control).await {
                Err(error) if attempts_left > 0 && passive_port_busy(&error) => {}
                answer => return answer,
            }
        }
    }

    pub(super) async fn ask_passive_port(
        &self,
        control: &mut AsyncRustlsFtpStream,
    ) -> BackendResult<u16> {
        if !self.extended.load(Ordering::SeqCst) {
            match control.custom_command("PASV", &[Status::PassiveMode]).await {
                Ok(reply) => {
                    return pasv_port(&reply.as_string().unwrap_or_default())
                        .ok_or_else(|| anyhow!("Unreadable reply to PASV"));
                }
                Err(error) => {
                    let error = anyhow::Error::from(error);
                    if !command_refused(&error) {
                        return Err(error);
                    }
                    // Some servers only speak EPSV, which works over IPv4 too.
                    self.extended.store(true, Ordering::SeqCst);
                }
            }
        }
        let reply = control
            .custom_command("EPSV", &[Status::ExtendedPassiveMode])
            .await?;
        epsv_port(&reply.as_string().unwrap_or_default())
            .ok_or_else(|| anyhow!("Unreadable reply to EPSV"))
    }
}
