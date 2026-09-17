//! The wire between the renderer and the backend: the machine-readable
//! failure codes, the error every command can return, and the response
//! envelopes. What a site or a connection *is* lives in `domain`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    AuthFailed,
    ConnectionRefused,
    TimedOut,
    HostKeyMismatch,
    InvalidCertificate,
    TlsNegotiationFailed,
    SshNegotiationFailed,
    ProxyFailed,
    NotFound,
    PermissionDenied,
    Cancelled,
    IntegrityMismatch,
    CleanupIncomplete,
    NetworkUnreachable,
    ConnectionLost,
    InvalidInput,
    ResourceLimit,
    /// The server has no room left for what is being written.
    StorageFull,
    /// A private key file could not be decrypted or parsed: most often a
    /// wrong passphrase.
    KeyUnreadable,
    /// Another operation is already reading or writing the same place.
    Busy,
    VaultLocked,
    /// Something already stands where this would go, and replacing it was
    /// not asked for.
    AlreadyExists,
    /// The server would not let an existing file be replaced, not even by
    /// setting it aside first.
    ReplaceUnsupported,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: ErrorCode,
    /// Safe fallback only. The renderer normally localizes `code`.
    pub message: String,
    /// Diagnostic context for logs; never put credentials in this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

pub type CommandResult<T> = Result<T, CommandError>;

/// The bare success/failure envelope shared by every command whose only
/// payload is "it worked". It lives here, with the wire types, because both
/// the command layer and the domain modules it calls into produce it —
/// owning it in either one would make the other depend on its caller.
#[derive(Debug, Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum OkResult {
    Ok { ok: bool },
    Err { ok: bool, error: CommandError },
}

/// Every command that needs a live connection reports its absence the same
/// way, so the message lives with the envelope rather than in whichever
/// command module happened to spell it first.
pub(crate) const NO_SESSION: &str = "No active connection";

pub(crate) fn ok() -> OkResult {
    OkResult::Ok { ok: true }
}

pub(crate) fn err(e: impl std::fmt::Display) -> OkResult {
    let details = e.to_string();
    OkResult::Err {
        ok: false,
        error: CommandError::from_anyhow(&anyhow::anyhow!(details)),
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        Self::from_anyhow(&error)
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self::from_anyhow(&error.into())
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn from_anyhow(error: &anyhow::Error) -> Self {
        if error.chain().any(|source| {
            source
                .downcast_ref::<reqwest::Error>()
                .is_some_and(|error| error.is_timeout())
                || source.is::<tokio::time::error::Elapsed>()
        }) {
            return Self::with_safe_message(ErrorCode::TimedOut, format!("{error:#}"));
        }
        if let Some(command_error) = error.downcast_ref::<CommandError>() {
            let mut typed = command_error.clone();
            // A driver that wrapped its typed error with `.context(...)` still
            // classifies by the code, but the context is the only thing saying
            // *which* call failed — keep it for the log.
            let rendered = format!("{error:#}");
            if typed.details.is_none() && rendered != typed.message {
                typed.details = Some(rendered);
            }
            return typed;
        }
        let details = format!("{error:#}");
        let code = error
            .chain()
            .find_map(Self::code_for_server_reply)
            .or_else(|| {
                error
                    .chain()
                    .find_map(|source| source.downcast_ref::<std::io::Error>())
                    .and_then(Self::code_for_io_error)
            })
            .unwrap_or_else(|| Self::code_for_message(&details));
        Self::with_safe_message(code, details)
    }

    /// A server's own verdict: an FTP reply code or an SFTP status. The reply
    /// text only splits the codes that servers use for more than one thing.
    fn code_for_server_reply(source: &(dyn std::error::Error + 'static)) -> Option<ErrorCode> {
        if let Some(suppaftp::FtpError::UnexpectedResponse(response)) =
            source.downcast_ref::<suppaftp::FtpError>()
        {
            let text = String::from_utf8_lossy(&response.body).to_ascii_lowercase();
            let too_many = text.contains("too many");
            return match response.status.code() {
                421 | 530 if too_many => Some(ErrorCode::ResourceLimit),
                530 => Some(ErrorCode::AuthFailed),
                421 => Some(ErrorCode::ConnectionLost),
                452 | 552 => Some(ErrorCode::StorageFull),
                // vsftpd's word for a write the disk would not take.
                451 if text.contains("failure writing") => Some(ErrorCode::StorageFull),
                // "File name not allowed": servers answer it for a folder
                // they will not write to.
                553 => Some(ErrorCode::PermissionDenied),
                550 if text.contains("no such")
                    || text.contains("not found")
                    || text.contains("not exist")
                    || text.contains("doesn't exist") =>
                {
                    Some(ErrorCode::NotFound)
                }
                550 if text.contains("permission")
                    || text.contains("denied")
                    || text.contains("not permitted") =>
                {
                    Some(ErrorCode::PermissionDenied)
                }
                _ => None,
            };
        }
        if let Some(russh_sftp::client::error::Error::Status(status)) =
            source.downcast_ref::<russh_sftp::client::error::Error>()
        {
            use russh_sftp::protocol::StatusCode;
            return match status.status_code {
                StatusCode::NoSuchFile => Some(ErrorCode::NotFound),
                StatusCode::PermissionDenied => Some(ErrorCode::PermissionDenied),
                StatusCode::ConnectionLost | StatusCode::NoConnection => {
                    Some(ErrorCode::ConnectionLost)
                }
                // SFTP v3 has no code for a full disk; the message says so.
                _ if Self::names_full_storage(&status.error_message.to_ascii_lowercase()) => {
                    Some(ErrorCode::StorageFull)
                }
                _ => None,
            };
        }
        None
    }

    fn names_full_storage(lower: &str) -> bool {
        lower.contains("no space left")
            || lower.contains("disk full")
            || lower.contains("quota exceeded")
            || lower.contains("insufficient storage")
    }

    /// Typed classification for the errors third-party crates hand us most
    /// often. `io::ErrorKind` is a real enum, so unlike the message matching
    /// below it survives any rewording upstream.
    fn code_for_io_error(error: &std::io::Error) -> Option<ErrorCode> {
        use std::io::ErrorKind;
        Some(match error.kind() {
            ErrorKind::TimedOut => ErrorCode::TimedOut,
            ErrorKind::ConnectionRefused => ErrorCode::ConnectionRefused,
            ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::BrokenPipe
            | ErrorKind::NotConnected
            | ErrorKind::UnexpectedEof => ErrorCode::ConnectionLost,
            ErrorKind::NotFound => ErrorCode::NotFound,
            ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            ErrorKind::Interrupted => ErrorCode::Cancelled,
            // `Other` and the kinds that say nothing about the cause fall
            // through to the message matching, which can still recognize a
            // protocol reply quoted inside the message.
            _ => return None,
        })
    }

    /// Last-resort fallback: matches the *rendered text* of errors that reach
    /// us untyped — third-party crate errors, and server replies quoted into a
    /// message. Every failure this app raises itself should carry a typed
    /// [`CommandError`] instead (see `protocol::fail`): reworded text silently
    /// reclassifies here, and nothing catches that.
    fn code_for_message(details: &str) -> ErrorCode {
        let lower = details.to_ascii_lowercase();
        if lower.contains("host_key_mismatch") || lower.contains("host key mismatch") {
            ErrorCode::HostKeyMismatch
        } else if lower.contains("530 ")
            || lower.contains("login incorrect")
            || lower.contains("auth fail")
            || lower.contains("401")
        {
            ErrorCode::AuthFailed
        } else if lower.contains("10061") || lower.contains("connection refused") {
            ErrorCode::ConnectionRefused
        } else if lower.contains("timed out")
            || lower.contains("timeout")
            || lower.contains("10060")
        {
            ErrorCode::TimedOut
        } else if lower.contains("certificate") || lower.contains("cert_") {
            ErrorCode::InvalidCertificate
        } else if lower.contains("tls handshake failed")
            || lower.contains("tls negotiation")
            || lower.contains("protocol version") && lower.contains("tls")
        {
            ErrorCode::TlsNegotiationFailed
        } else if lower.contains("ssh handshake failed")
            || lower.contains("ssh negotiation")
            || lower.contains("no common") && lower.contains("algorithm")
        {
            ErrorCode::SshNegotiationFailed
        } else if lower.contains("proxy handshake failed")
            || lower.contains("could not connect to proxy")
            || lower.contains("proxy rejected")
            || lower.contains("socks proxy")
        {
            ErrorCode::ProxyFailed
        } else if lower.contains("permission denied")
            || lower.contains("os error 5")
            || lower.contains("403")
        {
            ErrorCode::PermissionDenied
        } else if lower.contains("not found")
            || lower.contains("os error 2")
            || lower.contains("os error 3")
        {
            ErrorCode::NotFound
        } else if lower.contains("cancel") {
            ErrorCode::Cancelled
        } else if lower.contains("integrity")
            || lower.contains("checksum")
            || lower.contains("hash mismatch")
        {
            ErrorCode::IntegrityMismatch
        } else if lower.contains("10050") || lower.contains("10051") || lower.contains("10065") {
            ErrorCode::NetworkUnreachable
        } else if lower.contains("10052")
            || lower.contains("10053")
            || lower.contains("10054")
            || lower.contains("connection closed")
            || lower.contains("connection reset")
            || lower.contains("broken pipe")
            || lower.contains("unexpected eof")
            || lower.contains("socket")
        {
            ErrorCode::ConnectionLost
        } else if Self::names_full_storage(&lower) {
            ErrorCode::StorageFull
        } else if lower.contains("vault is locked") {
            ErrorCode::VaultLocked
        } else {
            ErrorCode::Internal
        }
    }

    /// Pairs a code with the safe, non-leaking sentence the renderer falls
    /// back to when it has no translation for the code, keeping the raw text
    /// in `details` for the log only.
    fn with_safe_message(code: ErrorCode, details: String) -> Self {
        let message = match code {
            ErrorCode::AuthFailed => "Authentication failed",
            ErrorCode::ConnectionRefused => "Connection refused",
            ErrorCode::TimedOut => "Operation timed out",
            ErrorCode::HostKeyMismatch => "Server host key changed",
            ErrorCode::InvalidCertificate => "Server certificate is invalid",
            ErrorCode::TlsNegotiationFailed => "TLS negotiation failed",
            ErrorCode::SshNegotiationFailed => "SSH negotiation failed",
            ErrorCode::ProxyFailed => "Proxy connection failed",
            ErrorCode::NotFound => "File or folder not found",
            ErrorCode::PermissionDenied => "Permission denied",
            ErrorCode::Cancelled => "Operation cancelled",
            ErrorCode::CleanupIncomplete => "Cleanup incomplete; unverified objects retained",
            ErrorCode::IntegrityMismatch => "Integrity verification failed",
            ErrorCode::NetworkUnreachable => "Network is unreachable",
            ErrorCode::ConnectionLost => "Connection lost",
            ErrorCode::InvalidInput => "Invalid input",
            ErrorCode::ResourceLimit => "Resource limit exceeded",
            ErrorCode::StorageFull => "Not enough storage space on the server",
            ErrorCode::KeyUnreadable => "The private key could not be read",
            ErrorCode::Busy => "Another operation is using this location",
            ErrorCode::VaultLocked => "Vault is locked",
            ErrorCode::AlreadyExists => "A file or folder with that name already exists",
            ErrorCode::ReplaceUnsupported => {
                "The server did not allow the existing file to be replaced"
            }
            ErrorCode::Internal => "Command failed",
        };
        Self {
            code,
            message: message.into(),
            details: Some(details),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn error_contract_is_camel_case_for_every_code() {
        let cases = [
            (ErrorCode::AuthFailed, "authFailed"),
            (ErrorCode::ConnectionRefused, "connectionRefused"),
            (ErrorCode::TimedOut, "timedOut"),
            (ErrorCode::HostKeyMismatch, "hostKeyMismatch"),
            (ErrorCode::InvalidCertificate, "invalidCertificate"),
            (ErrorCode::TlsNegotiationFailed, "tlsNegotiationFailed"),
            (ErrorCode::SshNegotiationFailed, "sshNegotiationFailed"),
            (ErrorCode::ProxyFailed, "proxyFailed"),
            (ErrorCode::NotFound, "notFound"),
            (ErrorCode::PermissionDenied, "permissionDenied"),
            (ErrorCode::Cancelled, "cancelled"),
            (ErrorCode::CleanupIncomplete, "cleanupIncomplete"),
            (ErrorCode::IntegrityMismatch, "integrityMismatch"),
            (ErrorCode::NetworkUnreachable, "networkUnreachable"),
            (ErrorCode::ConnectionLost, "connectionLost"),
            (ErrorCode::InvalidInput, "invalidInput"),
            (ErrorCode::ResourceLimit, "resourceLimit"),
            (ErrorCode::StorageFull, "storageFull"),
            (ErrorCode::KeyUnreadable, "keyUnreadable"),
            (ErrorCode::Busy, "busy"),
            (ErrorCode::VaultLocked, "vaultLocked"),
            (ErrorCode::AlreadyExists, "alreadyExists"),
            (ErrorCode::ReplaceUnsupported, "replaceUnsupported"),
            (ErrorCode::Internal, "internal"),
        ];
        for (code, expected) in cases {
            let value = serde_json::to_value(CommandError::new(code, "safe")).unwrap();
            assert_eq!(value["code"], expected);
            assert_eq!(value["message"], "safe");
        }
    }
    #[test]
    fn from_anyhow_passes_a_wrapped_command_error_through_unclassified() {
        let inner = CommandError::new(ErrorCode::InvalidInput, "Site name is required");
        let wrapped = anyhow::Error::new(inner.clone());

        assert_eq!(CommandError::from_anyhow(&wrapped), inner);
    }

    #[test]
    fn ftp_replies_and_sftp_statuses_classify_by_code() {
        let ftp = |code: u32, text: &str| {
            let error = anyhow::Error::from(suppaftp::FtpError::UnexpectedResponse(
                suppaftp::types::Response::new(
                    suppaftp::Status::from(code),
                    format!("{code} {text}").into_bytes(),
                ),
            ))
            .context("command failed");
            CommandError::from_anyhow(&error).code
        };
        assert_eq!(ftp(530, "Login incorrect."), ErrorCode::AuthFailed);
        assert_eq!(
            ftp(530, "Too many connections from your host (limit 8)"),
            ErrorCode::ResourceLimit
        );
        assert_eq!(
            ftp(
                421,
                "There are too many connections from your internet address."
            ),
            ErrorCode::ResourceLimit
        );
        assert_eq!(ftp(421, "Timeout."), ErrorCode::ConnectionLost);
        assert_eq!(
            ftp(550, "/a.txt: No such file or directory"),
            ErrorCode::NotFound
        );
        assert_eq!(
            ftp(550, "/a.txt: Operation not permitted"),
            ErrorCode::PermissionDenied
        );
        assert_eq!(ftp(550, "Failed to open file."), ErrorCode::Internal);
        assert_eq!(ftp(552, "Disk full"), ErrorCode::StorageFull);
        assert_eq!(
            ftp(451, "Failure writing to local file."),
            ErrorCode::StorageFull
        );
        assert_eq!(
            ftp(553, "Could not create file."),
            ErrorCode::PermissionDenied
        );

        let sftp = |status_code, message: &str| {
            let error = anyhow::Error::from(russh_sftp::client::error::Error::Status(
                russh_sftp::protocol::Status {
                    id: 1,
                    status_code,
                    error_message: message.to_owned(),
                    language_tag: String::new(),
                },
            ));
            CommandError::from_anyhow(&error).code
        };
        use russh_sftp::protocol::StatusCode;
        assert_eq!(
            sftp(StatusCode::NoSuchFile, "No such file"),
            ErrorCode::NotFound
        );
        assert_eq!(
            sftp(StatusCode::PermissionDenied, "Permission denied"),
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            sftp(StatusCode::Failure, "No space left on device"),
            ErrorCode::StorageFull
        );
    }

    #[test]
    fn negotiation_and_proxy_failures_have_stable_codes() {
        let cases = [
            (
                "TLS handshake failed: peer aborted protocol negotiation",
                ErrorCode::TlsNegotiationFailed,
            ),
            (
                "SSH handshake failed: no common key exchange algorithm",
                ErrorCode::SshNegotiationFailed,
            ),
            (
                "SOCKS5 proxy handshake failed: proxy rejected connection",
                ErrorCode::ProxyFailed,
            ),
            (
                "error connecting to socks proxy: SOCKS error: credentials not accepted",
                ErrorCode::ProxyFailed,
            ),
        ];
        for (details, expected) in cases {
            assert_eq!(
                CommandError::from_anyhow(&anyhow::anyhow!(details)).code,
                expected
            );
        }
    }
}
