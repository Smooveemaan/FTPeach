//! A value that forgets itself.
//!
//! Every copy clears its buffer when it goes out of scope, which is the
//! point: a connection config is cloned into each protocol backend and into
//! a transfer pool's factory, and a hand-written `zeroize()` after an
//! `.await` never runs when the future is dropped before reaching that line.
//! Reading the value is deliberately explicit, so a secret only leaves the
//! wrapper where someone wrote `expose()`, and Debug prints nothing. There is
//! deliberately no Display: `format!("PASS {password}")` would compile and
//! send the placeholder instead of the password.
//!
//! This cannot promise the bytes are gone from the process. A `String` that
//! grew leaves its old buffer behind, `serde_json` held the password while
//! parsing the request, and the TLS, HTTP and SSH libraries, the WebView and
//! the operating system all keep copies of their own on the way to the wire.
//! What it does is keep FTPeach's own long-lived copies from outliving their
//! use, and keep them out of a log line.
use serde::Deserialize;
use zeroize::Zeroize;

#[derive(Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct SensitiveString(String);

impl SensitiveString {
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<String> for SensitiveString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SensitiveString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl std::fmt::Debug for SensitiveString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SensitiveString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "ftpeach-secret-marker";

    #[test]
    fn debug_does_not_print_the_value() {
        let secret = SensitiveString::from(MARKER);
        assert_eq!(format!("{secret:?}"), "[REDACTED]");
        assert_eq!(secret.expose(), MARKER);
    }

    #[test]
    fn a_secret_arrives_from_ipc_as_a_plain_string_field() {
        #[derive(Deserialize)]
        struct Request {
            password: SensitiveString,
        }
        let request: Request = serde_json::from_str(&format!(r#"{{"password":"{MARKER}"}}"#))
            .expect("a secret field deserializes like the String it replaced");
        assert_eq!(request.password.expose(), MARKER);
        assert!(!format!("{:?}", request.password).contains(MARKER));
    }
}
