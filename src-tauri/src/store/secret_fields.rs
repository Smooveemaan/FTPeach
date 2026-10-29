//! The fields that hold or name a saved secret, and the per-record
//! encryption shared by the sites domain (a saved site's password/key
//! passphrase) and the settings domain (the global proxy password). Every
//! function below operates on a single `JsonMap` record and an
//! `enc`/`plain` field-name pair the caller chooses.
//!
//! A new secret field goes into its group below; the export, the import and
//! the backup filter each take the groups they need from here.

use super::{JsonMap, Store};
use crate::security::system_protection;
use anyhow::Result;
use base64::Engine;
use serde_json::Value;
use zeroize::Zeroize;

/// Where `sites.json` keeps a bookmark's password and key passphrase:
/// DPAPI-protected, then legacy plaintext.
pub(crate) const SITE_SAVED: [&str; 4] = ["enc", "plain", "keyEnc", "keyPlain"];
/// What a bookmark edit sends to set or clear them.
pub(crate) const SITE_INPUT: [&str; 4] = [
    "password",
    "keyPassphrase",
    "removePassword",
    "removeKeyPassphrase",
];
/// Where `settings.json` keeps the proxy password.
pub(crate) const PROXY_SAVED: [&str; 2] = ["proxyPasswordEnc", "proxyPasswordPlain"];
/// What a settings save sends to set or clear it.
pub(crate) const PROXY_INPUT: [&str; 2] = ["proxyPassword", "removeProxyPassword"];
/// That a proxy password exists: in the vault, and as the renderer is told.
pub(crate) const PROXY_FLAGS: [&str; 2] = ["hasProxyPassword", "proxyPasswordSet"];
/// The legacy plaintext fields among the saved ones.
pub(crate) const PLAINTEXT: [&str; 3] = ["plain", "keyPlain", "proxyPasswordPlain"];

/// Every field that holds or names the proxy password.
pub(crate) fn proxy_secret_fields() -> impl Iterator<Item = &'static str> {
    PROXY_INPUT
        .into_iter()
        .chain(PROXY_SAVED)
        .chain(PROXY_FLAGS)
}

#[cfg(test)]
thread_local! {
    pub(super) static SIMULATE_DPAPI_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl Store {
    pub(super) fn protect_secret(data: &[u8]) -> Result<Vec<u8>> {
        // Manual UI test hook. It is compiled only for debug builds, so an
        // environment variable can never disable DPAPI in a packaged release.
        #[cfg(debug_assertions)]
        if std::env::var_os("FTPEACH_SIMULATE_DPAPI_FAILURE").is_some() {
            anyhow::bail!("simulated DPAPI failure");
        }
        // Tests fail DPAPI on their own thread only: the environment variable
        // would fail it for every test running in parallel.
        #[cfg(test)]
        if SIMULATE_DPAPI_FAILURE.get() {
            anyhow::bail!("simulated DPAPI failure");
        }

        system_protection::protect(data)
    }

    // ---------- secrets ----------

    pub(super) fn decrypt_secret(site: &JsonMap, field_enc: &str, field_plain: &str) -> String {
        if let Some(Value::String(enc)) = site.get(field_enc) {
            let decoded = base64::engine::general_purpose::STANDARD.decode(enc);
            if let Ok(bytes) = decoded
                && let Ok(mut plain) = system_protection::unprotect(&bytes)
            {
                let secret = String::from_utf8_lossy(&plain).into_owned();
                plain.zeroize();
                return secret;
            }
            return String::new();
        }
        site.get(field_plain)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    pub(super) fn has_saved_secret(site: &JsonMap, field_enc: &str, field_plain: &str) -> bool {
        site.get(field_enc)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
            || site
                .get(field_plain)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
    }

    pub(super) fn secret_undecryptable(site: &JsonMap, field_enc: &str) -> bool {
        let Some(Value::String(enc)) = site.get(field_enc) else {
            return false;
        };
        match base64::engine::general_purpose::STANDARD.decode(enc) {
            Ok(bytes) => match system_protection::unprotect(&bytes) {
                Ok(mut plain) => {
                    plain.zeroize();
                    false
                }
                Err(_) => true,
            },
            Err(_) => true,
        }
    }

    pub(super) fn secret_is_plaintext(site: &JsonMap, field_plain: &str) -> bool {
        site.get(field_plain)
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
    }

    pub(super) fn migrate_plaintext_field<F>(
        site: &mut JsonMap,
        field_plain: &str,
        field_enc: &str,
        protect: F,
    ) -> bool
    where
        F: FnOnce(&[u8]) -> Result<Vec<u8>>,
    {
        let Some(value) = site.get(field_plain).cloned() else {
            return false;
        };

        let Some(secret) = value.as_str() else {
            // An invalid non-string value cannot contain a usable credential.
            site.remove(field_plain);
            return true;
        };
        if secret.is_empty() {
            site.remove(field_plain);
            return true;
        }

        let Ok(protected) = protect(secret.as_bytes()) else {
            return false;
        };
        site.insert(
            field_enc.into(),
            Value::String(base64::engine::general_purpose::STANDARD.encode(protected)),
        );
        site.remove(field_plain);
        true
    }

    pub(super) fn encrypt_secret_with<F>(
        secret: &str,
        existing: Option<&JsonMap>,
        field_enc: &str,
        field_plain: &str,
        protect: F,
    ) -> (Option<(String, Value)>, bool)
    where
        F: FnOnce(&[u8]) -> Result<Vec<u8>>,
    {
        if secret.is_empty() {
            if let Some(existing) = existing {
                if let Some(value) = existing.get(field_enc) {
                    return (Some((field_enc.to_string(), value.clone())), false);
                }
                if let Some(Value::String(plain)) = existing.get(field_plain) {
                    if plain.is_empty() {
                        return (None, false);
                    }
                    return match protect(plain.as_bytes()) {
                        Ok(protected) => (
                            Some((
                                field_enc.to_string(),
                                Value::String(
                                    base64::engine::general_purpose::STANDARD.encode(protected),
                                ),
                            )),
                            false,
                        ),
                        Err(_) => (
                            Some((field_plain.to_string(), Value::String(plain.clone()))),
                            true,
                        ),
                    };
                }
            }
            return (None, false);
        }
        if let Some(existing) = existing
            && existing.get(field_enc).is_some()
            && Self::decrypt_secret(existing, field_enc, field_plain) == secret
        {
            return (
                Some((field_enc.to_string(), existing[field_enc].clone())),
                false,
            );
        }
        match protect(secret.as_bytes()) {
            Ok(protected) => (
                Some((
                    field_enc.to_string(),
                    Value::String(base64::engine::general_purpose::STANDARD.encode(protected)),
                )),
                false,
            ),
            // The new secret cannot be protected, so it is not saved at all;
            // whatever was saved before stays, rather than being dropped.
            Err(_) => (
                existing
                    .and_then(|existing| existing.get(field_enc))
                    .map(|value| (field_enc.to_string(), value.clone())),
                true,
            ),
        }
    }
}
