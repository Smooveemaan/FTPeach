//! Secret-safe diagnostics primitives. All protocol/file/IPC diagnostic text
//! crosses this module before it can leave the process.

use regex::{Captures, Regex};
use std::sync::OnceLock;

const REDACTED: &str = "[REDACTED]";
pub const MAX_RENDERER_LOG_BYTES: usize = 2 * 1024 * 1024;

fn credential_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?ix)
            (authorization\s*:\s*(?:basic|bearer)?\s*)[^\s,;]+ |
            ("?(?:password|passwd|passphrase|private[_-]?key|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)"?\s*[=:]\s*)
            (?:\"[^\"]*\"|'[^']*'|[^\s&,;\"'\]\}]+)
            "#,
        )
        .expect("diagnostic credential regex must compile")
    })
}

fn sensitive_query_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)([?&](?:password|passwd|passphrase|token|access_token|refresh_token|api_key|key|secret|signature|sig)=)[^&#\s]*",
        )
        .expect("diagnostic query regex must compile")
    })
}

fn encoded_query_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)((?:password|passwd|passphrase|token|access_token|refresh_token|api_key|key|secret|signature|sig)(?:%25|%)3d)[^%&\s<]+")
            .expect("encoded diagnostic query regex must compile")
    })
}

fn url_userinfo_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)([a-z][a-z0-9+.\-]*://)[^/@\s]+@")
            .expect("URL userinfo diagnostic regex must compile")
    })
}

fn xml_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?is)(<(?:password|passphrase|authorization|private[_-]?key|token|secret)\b[^>]*>).*?(</[^>]+>)")
            .expect("XML diagnostic secret regex must compile")
    })
}

fn private_key_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?is)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?-----END [^-\r\n]*PRIVATE KEY-----",
        )
        .expect("private-key diagnostic regex must compile")
    })
}

/// Redacts credentials regardless of protocol/backend formatting. Keep this
/// as the final gate even when a backend already avoids logging secrets.
pub fn redact(input: &str) -> String {
    let no_url_userinfo = url_userinfo_pattern().replace_all(input, |caps: &Captures<'_>| {
        format!("{}{}@", &caps[1], REDACTED)
    });
    let private_keys = private_key_pattern().replace_all(&no_url_userinfo, REDACTED);
    let xml = xml_secret_pattern().replace_all(&private_keys, |caps: &Captures<'_>| {
        format!("{}{}{}", &caps[1], REDACTED, &caps[2])
    });
    let credentials = credential_pattern().replace_all(&xml, |caps: &Captures<'_>| {
        format!(
            "{}{}",
            caps.get(1).or_else(|| caps.get(2)).unwrap().as_str(),
            REDACTED
        )
    });
    let queries = sensitive_query_pattern()
        .replace_all(&credentials, |caps: &Captures<'_>| {
            format!("{}{}", &caps[1], REDACTED)
        })
        .into_owned();
    encoded_query_pattern()
        .replace_all(&queries, |caps: &Captures<'_>| {
            let prefix = caps.get(1).unwrap().as_str();
            let separator = prefix.rfind(['d', 'D']).unwrap_or(prefix.len() - 1);
            format!("{}{}", &prefix[..=separator], REDACTED)
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_headers_fields_and_sensitive_query_values() {
        for value in [
            "Authorization: Bearer top-secret",
            "password=hunter2 host=example.test",
            r#""private_key":"PEM DATA""#,
            "https://example.test/a?file=ok&token=abc123&sig=deadbeef",
        ] {
            let output = redact(value);
            assert!(!output.contains("top-secret"));
            assert!(!output.contains("hunter2"));
            assert!(!output.contains("PEM DATA"));
            assert!(!output.contains("abc123"));
            assert!(!output.contains("deadbeef"));
            assert!(output.contains("[REDACTED]"));
        }
    }

    #[test]
    fn redacts_multiline_encoded_json_xml_and_nonstandard_headers() {
        let secret = "known-secret-4f9d";
        for value in [
            format!("Authorization : Basic\n{secret}"),
            format!("GET /?token%3D{secret}"),
            format!("GET /?token%253D{secret}"),
            format!(r#"{{"password":"{secret}"}}"#),
            format!("<password>{secret}</password>"),
            format!("X-Api-Key = {secret}"),
            format!(
                "-----BEGIN OPENSSH PRIVATE KEY-----\n{secret}\n-----END OPENSSH PRIVATE KEY-----"
            ),
        ] {
            let output = redact(&value);
            assert!(
                !output.contains(secret),
                "secret leaked from {value:?}: {output}"
            );
        }
    }

    #[test]
    fn generated_secrets_never_survive_redaction() {
        for index in 0..256u32 {
            let secret = format!("property-secret-{index:08x}");
            let input = format!("password={secret} GET /?token={secret}");
            assert!(!redact(&input).contains(&secret));
        }
    }

    #[test]
    fn redacts_credentials_embedded_in_a_url() {
        let output = redact("connecting to https://alice:hunter2@dav.example.test/remote.php");
        assert!(!output.contains("alice"));
        assert!(!output.contains("hunter2"));
        assert!(output.contains("[REDACTED]@dav.example.test"));
    }

    #[test]
    fn preserves_non_sensitive_protocol_text() {
        assert_eq!(
            redact("GET /public?file=readme.txt 200"),
            "GET /public?file=readme.txt 200"
        );
    }
}
