//! Host-key persistence contract used by SFTP.
//! Store failures must propagate; a failed read does not establish first trust.

use anyhow::Result;
use async_trait::async_trait;

/// What checking a host key against the stored pin can conclude: a first
/// sighting that was just pinned, a first sighting the caller is not allowed
/// to pin on its own, a repeat connection whose key still matches, or a
/// changed key whose stored pin was deliberately left alone.
#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyPinOutcome {
    Pinned,
    Matched,
    /// No key is stored and first contact has to be confirmed by the user,
    /// so nothing was written and nothing was accepted.
    Unknown,
    Mismatched {
        expected: String,
    },
}

#[async_trait]
pub trait KnownHostsStore: Send + Sync {
    /// Checks the stored fingerprint for `host:port` against `fingerprint`,
    /// pinning it if none is stored yet.
    ///
    /// Deciding "is this a first sighting" and pinning it must be one
    /// operation: split into a get and a set, two connections to the same
    /// never-before-seen host could both see "no pinned key yet" and each pin
    /// its own peer's key, with the later write silently overwriting the
    /// other and no mismatch ever reported.
    ///
    /// `allow_first_pin` is the connection's trust-on-first-use policy: with
    /// it, an unknown host is pinned and accepted, which is what makes a
    /// first connection painless and a first-contact impostor invisible.
    /// Without it, an unknown host is reported as `Unknown` and the key is
    /// neither stored nor accepted until the user confirms this fingerprint.
    async fn pin_or_verify(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
        allow_first_pin: bool,
    ) -> Result<HostKeyPinOutcome>;
}
