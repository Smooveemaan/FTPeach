//! The server's host key, trusted on first use: checked against what this
//! computer knows before any credential is offered.
use super::*;

/// A host key the connection would not accept on its own: either it
/// changed, or this is a first sighting and the connection is not allowed to
/// trust one unseen. Both stop before any credential is offered, and both
/// need the same answer from the user: trust this exact fingerprint.
#[derive(Debug)]
pub struct HostKeyMismatchError {
    pub host: String,
    pub port: u16,
    /// The pinned fingerprint, or `None` on a first sighting.
    pub expected: Option<String>,
    pub actual: String,
}

impl std::fmt::Display for HostKeyMismatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.expected {
            Some(expected) => write!(
                formatter,
                "The server key for {}:{} has changed since the last connection (expected SHA256 \
                 fingerprint {}, got {}). This may indicate a spoofed server (a man-in-the-middle \
                 attack) or that the server was reinstalled. Connection stopped.",
                self.host, self.port, expected, self.actual
            ),
            None => write!(
                formatter,
                "This is the first connection to {}:{}, and its SHA256 host key fingerprint {} \
                 has not been confirmed. Compare it with the fingerprint the server's \
                 administrator published before trusting it. Connection stopped.",
                self.host, self.port, self.actual
            ),
        }
    }
}

impl std::error::Error for HostKeyMismatchError {}

pub(super) fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

pub(super) struct TofuHandler {
    pub(super) known_hosts: Arc<dyn KnownHostsStore>,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) mismatch: Arc<StdMutex<Option<HostKeyMismatchError>>>,
    /// Trust on first use. Off, an unknown host is refused until the user
    /// has seen and confirmed its fingerprint.
    pub(super) allow_first_pin: bool,
}

impl client::Handler for TofuHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let raw = server_public_key
            .public_key()
            .to_bytes()
            .context("encoding host public key")?;
        let fingerprint = encode_hex(&Sha256::digest(&raw));

        match self
            .known_hosts
            .pin_or_verify(&self.host, self.port, &fingerprint, self.allow_first_pin)
            .await
            .context("pinning host key to known_hosts.json")?
        {
            HostKeyPinOutcome::Pinned | HostKeyPinOutcome::Matched => Ok(true),
            outcome => {
                *self.mismatch.lock().unwrap() = Some(HostKeyMismatchError {
                    host: self.host.clone(),
                    port: self.port,
                    expected: match outcome {
                        HostKeyPinOutcome::Mismatched { expected } => Some(expected),
                        _ => None,
                    },
                    actual: fingerprint,
                });
                Ok(false)
            }
        }
    }
}
