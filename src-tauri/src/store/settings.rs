//! The global `settings.json` store, including the proxy password (a
//! single process-wide secret, never vault-protected — see `set_settings`'s
//! own comment for why that's a deliberate difference from a saved site's
//! password).

use super::{JsonMap, Store};
use crate::ipc::{CommandError, ErrorCode};
use anyhow::Result;
use serde_json::Value;
use std::path::PathBuf;

impl Store {
    fn settings_file(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    // ---------- settings ----------

    pub fn default_settings() -> JsonMap {
        let mut defaults: JsonMap =
            serde_json::from_str(include_str!("../../../src/shared/settingsDefaults.json"))
                .expect("shared settings defaults must be a JSON object");
        // First-launch language detection owns `language`; proxyPasswordSet
        // is a transient flag added by settings_get and is never persisted.
        defaults.remove("language");
        defaults.remove("proxyPasswordSet");
        defaults
    }

    pub async fn get_settings(&self) -> JsonMap {
        let mut merged = Self::default_settings();
        let stored: Option<JsonMap> = self.read_json(&self.settings_file(), None).await;
        if let Some(stored) = stored {
            for (k, v) in stored {
                merged.insert(k, v);
            }
        }
        merged
    }

    pub async fn set_settings(&self, patch: JsonMap) -> Result<JsonMap> {
        super::validate_settings(&patch, true).map_err(|message| {
            anyhow::anyhow!(CommandError::new(ErrorCode::InvalidInput, message))
        })?;
        let path = self.settings_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut current = self.get_settings().await;

        let mut patch = patch;
        let raw_password = patch.remove("proxyPassword");
        let remove_password = patch
            .remove("removeProxyPassword")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        for (k, v) in patch {
            current.insert(k, v);
        }

        let mut public_settings = current.clone();
        for key in ["proxyPasswordEnc", "proxyPasswordPlain", "proxyPasswordSet"] {
            public_settings.remove(key);
        }
        super::validate_settings(&public_settings, false).map_err(|message| {
            anyhow::anyhow!(CommandError::new(ErrorCode::InvalidInput, message))
        })?;

        if remove_password {
            current.remove("proxyPasswordEnc");
            current.remove("proxyPasswordPlain");
        } else if let Some(Value::String(password)) = raw_password {
            let (field, _secret_not_persisted) = Self::encrypt_secret_with(
                &password,
                Some(&current),
                "proxyPasswordEnc",
                "proxyPasswordPlain",
                Self::protect_secret,
            );
            current.remove("proxyPasswordEnc");
            current.remove("proxyPasswordPlain");
            if let Some((f, v)) = field {
                current.insert(f, v);
            }
        }

        self.write_json(&path, &current).await?;
        Ok(current)
    }

    pub(crate) async fn replace_settings_for_import(&self, settings: &JsonMap) -> Result<()> {
        let path = self.settings_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        self.write_json(&path, settings).await
    }

    // ---------- proxy ----------

    /// Reads the global proxy settings and, if enabled, decrypts the saved
    /// password — ready to merge straight into a connect-time config map.
    /// Called once per connect attempt from
    /// `application/session_service.rs`: the proxy password never
    /// round-trips through the renderer on connect, only through this
    /// direct settings.json → Rust path (see `reveal_proxy_password` for
    /// the one place it *does* cross to the renderer — the settings-dialog
    /// "show password" action, on demand only).
    pub async fn proxy_config_for_connect(&self) -> JsonMap {
        let settings = self.get_settings().await;
        let mut out = JsonMap::new();
        let requested = settings
            .get("proxyEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let enabled = requested
            && settings
                .get("proxyHost")
                .and_then(Value::as_str)
                .is_some_and(|host| !host.trim().is_empty())
            && settings
                .get("proxyPort")
                .and_then(Value::as_u64)
                .is_some_and(|port| (1..=u16::MAX as u64).contains(&port));
        out.insert("proxyEnabled".into(), Value::Bool(enabled));
        if !enabled {
            return out;
        }
        for key in ["proxyType", "proxyHost", "proxyPort", "proxyUsername"] {
            if let Some(v) = settings.get(key) {
                out.insert(key.into(), v.clone());
            }
        }
        if Self::has_saved_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain") {
            let password =
                Self::decrypt_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain");
            if !password.is_empty() {
                out.insert("proxyPassword".into(), Value::String(password));
            }
        }
        out
    }

    /// Decrypts the saved proxy password for the settings dialog's "show
    /// password" action — same contract as `reveal_dpapi_secret` (a saved
    /// site's password), minus the vault gate: the proxy password is never
    /// vault-protected in the first place (see `set_settings`'s own
    /// comment), so there's nothing for a vault check to guard here.
    pub async fn reveal_proxy_password(&self) -> Result<Option<String>> {
        let settings = self.get_settings().await;
        if !Self::has_saved_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain") {
            return Ok(None);
        }
        let secret = Self::decrypt_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain");
        if secret.is_empty() {
            anyhow::bail!("saved proxy password could not be decrypted");
        }
        Ok(Some(secret))
    }

    pub async fn reset_layout_settings(&self) -> Result<JsonMap> {
        let defaults = Self::default_settings();
        let mut patch = JsonMap::new();
        for key in [
            "localColumns",
            "remoteColumns",
            "localColumnWidths",
            "remoteColumnWidths",
            "transferColumnWidths",
            "transferColumnOrder",
            "showLocalPane",
            "showRemotePane",
            "showTransferQueue",
            "transferQueueHeight",
            "logEnabled",
            "logPanelHeight",
            "splitRatio",
            "paneOrientation",
            "transferLogSplitRatio",
            "windowBounds",
            "windowMaximized",
        ] {
            patch.insert(
                key.into(),
                defaults.get(key).cloned().unwrap_or(Value::Null),
            );
        }
        self.set_settings(patch).await
    }
}
