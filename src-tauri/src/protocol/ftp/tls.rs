//! TLS for FTPS: whether a server speaks it before its greeting, the session
//! cache data connections resume, and the verifier for an untrusted certificate.
use super::*;

/// Whether the server completes a TLS handshake on a fresh connection, as an
/// implicit FTPS server does before it sends any greeting.
pub(super) async fn answers_tls(
    host: &str,
    port: u16,
    proxy: Option<&crate::protocol::transport::ProxyConfig>,
) -> bool {
    let Ok(config) = FtpBackend::build_tls_config(true, None) else {
        return false;
    };
    let Ok(name) = ServerName::try_from(host.to_owned()) else {
        return false;
    };
    let probe = async {
        let tcp = crate::protocol::transport::connect(host, port, proxy).await?;
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        anyhow::Ok(connector.connect(name, tcp).await?)
    };
    matches!(
        tokio::time::timeout(IMPLICIT_PROBE_WAIT, probe).await,
        Ok(Ok(_))
    )
}
/// The TLS session cache of one FTPS connection, counting the TLS 1.3 tickets
/// it holds. rustls spends each ticket once, and a server that requires data
/// connections to resume the control session (vsftpd does by default) refuses
/// one that has none left with 522.
#[derive(Debug)]
pub(super) struct SessionTickets {
    cache: rustls::client::ClientSessionMemoryCache,
    held: std::sync::atomic::AtomicUsize,
    inserted: tokio::sync::Notify,
    /// Cleared once a server was seen not to send a ticket in time, so no
    /// upload waits for one again.
    arrive: AtomicBool,
}

impl SessionTickets {
    pub(super) fn new() -> Self {
        Self {
            // rustls' own default. The cache sizes its server slots from
            // this, and too few leave no room for the session to resume.
            cache: rustls::client::ClientSessionMemoryCache::new(256),
            held: std::sync::atomic::AtomicUsize::new(0),
            inserted: tokio::sync::Notify::new(),
            arrive: AtomicBool::new(true),
        }
    }

    /// A download reads what its data connection receives, the server's new
    /// ticket included, but an upload only writes. Reading after the upload's
    /// handshake takes that ticket in, so the next data connection has one.
    pub(super) async fn replenish(
        &self,
        tls: &mut tokio_rustls::client::TlsStream<tokio::net::TcpStream>,
    ) {
        let tls13 = tls.get_ref().1.protocol_version() == Some(rustls::ProtocolVersion::TLSv1_3);
        if !tls13 || self.held.load(Ordering::SeqCst) > 0 || !self.arrive.load(Ordering::SeqCst) {
            return;
        }
        let inserted = self.inserted.notified();
        tokio::pin!(inserted);
        inserted.as_mut().enable();
        if self.held.load(Ordering::SeqCst) > 0 {
            return;
        }
        // No application data comes before the file does: a server sends
        // nothing on an upload's data connection.
        let mut byte = [0u8; 1];
        tokio::select! {
            _ = &mut inserted => {}
            _ = tls.read(&mut byte) => {}
            _ = tokio::time::sleep(TICKET_WAIT) => self.arrive.store(false, Ordering::SeqCst),
        }
    }
}

impl rustls::client::ClientSessionStore for SessionTickets {
    fn set_kx_hint(&self, server_name: ServerName<'static>, group: rustls::NamedGroup) {
        self.cache.set_kx_hint(server_name, group);
    }
    fn kx_hint(&self, server_name: &ServerName<'_>) -> Option<rustls::NamedGroup> {
        self.cache.kx_hint(server_name)
    }
    fn set_tls12_session(
        &self,
        server_name: ServerName<'static>,
        value: rustls::client::Tls12ClientSessionValue,
    ) {
        self.cache.set_tls12_session(server_name, value);
    }
    fn tls12_session(
        &self,
        server_name: &ServerName<'_>,
    ) -> Option<rustls::client::Tls12ClientSessionValue> {
        self.cache.tls12_session(server_name)
    }
    fn remove_tls12_session(&self, server_name: &ServerName<'static>) {
        self.cache.remove_tls12_session(server_name);
    }
    fn insert_tls13_ticket(
        &self,
        server_name: ServerName<'static>,
        value: rustls::client::Tls13ClientSessionValue,
    ) {
        self.cache.insert_tls13_ticket(server_name, value);
        // The cache keeps at most eight and drops the oldest.
        let _ = self
            .held
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                Some((held + 1).min(8))
            });
        self.inserted.notify_waiters();
    }
    fn take_tls13_ticket(
        &self,
        server_name: &ServerName<'static>,
    ) -> Option<rustls::client::Tls13ClientSessionValue> {
        let ticket = self.cache.take_tls13_ticket(server_name);
        if ticket.is_some() {
            let _ = self
                .held
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                    held.checked_sub(1)
                });
        } else {
            self.held.store(0, Ordering::SeqCst);
        }
        ticket
    }
}
#[derive(Debug)]
pub(super) struct NoCertVerification;

impl rustls::client::danger::ServerCertVerifier for NoCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &rustls_pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
