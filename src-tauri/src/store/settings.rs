//! The global `settings.json` store, including the proxy password. Like a
//! saved site's password, it is encrypted with DPAPI under system protection
//! and lives in the vault under enhanced protection, where `settings.json`
//! keeps only the `hasProxyPassword` flag.

use super::{JsonMap, Store};
use crate::ipc::{CommandError, ErrorCode};
use crate::security::vault::{SecretUpdate, Vault};
use anyhow::{Context, Result};
use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use zeroize::{Zeroize, Zeroizing};

/// Where a settings write leaves the proxy password.
enum ProxyPasswordWrite {
    /// Apply the patch's `proxyPassword`/`removeProxyPassword` with DPAPI.
    Dpapi,
    /// The vault was already updated; record whether it now holds a password.
    Vault { saved: bool },
}

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
        self.write_settings(patch, ProxyPasswordWrite::Dpapi).await
    }

    /// `set_settings` for the settings dialog: under enhanced protection a
    /// new or removed proxy password goes through the vault, which must be
    /// unlocked. A failed settings write restores the previous vault value.
    pub async fn set_settings_with_vault(&self, patch: JsonMap, vault: &Vault) -> Result<JsonMap> {
        if !vault.is_configured() {
            return self.set_settings(patch).await;
        }
        let store = self.clone();
        let vault = vault.clone();
        tokio::spawn(async move {
            let _transaction = store.vault_updates.lock().await;
            store.set_settings_with_vault_inner(patch, &vault).await
        })
        .await
        .context("settings save task failed")?
    }

    async fn set_settings_with_vault_inner(
        &self,
        mut patch: JsonMap,
        vault: &Vault,
    ) -> Result<JsonMap> {
        super::validate_settings(&patch, true).map_err(|message| {
            anyhow::anyhow!(CommandError::new(ErrorCode::InvalidInput, message))
        })?;
        let mut password = match patch.remove("proxyPassword") {
            Some(Value::String(password)) if !password.is_empty() => Some(password),
            _ => None,
        };
        let remove_password = patch
            .remove("removeProxyPassword")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if password.is_none() && !remove_password {
            return self.set_settings(patch).await;
        }
        if !vault.is_unlocked().await {
            anyhow::bail!("vault is locked");
        }

        let previous = vault.get_proxy_password().await?;
        let update = match &password {
            Some(password) if !remove_password => SecretUpdate::SetProxyPassword {
                value: password.as_bytes(),
            },
            _ => SecretUpdate::DeleteProxyPassword,
        };
        let saved = matches!(update, SecretUpdate::SetProxyPassword { .. });
        let applied = vault.apply_secret_updates(&[update]).await;
        if let Some(password) = password.as_mut() {
            password.zeroize();
        }
        applied?;

        match self
            .write_settings(patch, ProxyPasswordWrite::Vault { saved })
            .await
        {
            Ok(settings) => Ok(settings),
            Err(error) => {
                restore_proxy_password(vault, previous.as_deref())
                    .await
                    .with_context(|| {
                        format!("Settings save failed ({error:#}); vault rollback also failed")
                    })?;
                Err(error)
            }
        }
    }

    async fn write_settings(
        &self,
        patch: JsonMap,
        proxy_password: ProxyPasswordWrite,
    ) -> Result<JsonMap> {
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
        for key in [
            "proxyPasswordEnc",
            "proxyPasswordPlain",
            "proxyPasswordSet",
            "hasProxyPassword",
        ] {
            public_settings.remove(key);
        }
        super::validate_settings(&public_settings, false).map_err(|message| {
            anyhow::anyhow!(CommandError::new(ErrorCode::InvalidInput, message))
        })?;

        match proxy_password {
            ProxyPasswordWrite::Vault { saved } => {
                current.remove("proxyPasswordEnc");
                current.remove("proxyPasswordPlain");
                if saved {
                    current.insert("hasProxyPassword".into(), Value::Bool(true));
                } else {
                    current.remove("hasProxyPassword");
                }
            }
            ProxyPasswordWrite::Dpapi if remove_password => {
                current.remove("proxyPasswordEnc");
                current.remove("proxyPasswordPlain");
            }
            ProxyPasswordWrite::Dpapi => {
                if let Some(Value::String(password)) = raw_password {
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

    fn proxy_password_in_vault(settings: &JsonMap) -> bool {
        settings.get("hasProxyPassword").and_then(Value::as_bool) == Some(true)
    }

    /// Reads the global proxy settings and, if enabled, resolves the saved
    /// password — ready to merge straight into a connect-time config map.
    /// Called once per connect attempt from
    /// `application/session_service.rs`: the proxy password never
    /// round-trips through the renderer on connect, only through this
    /// backend path (see `reveal_proxy_password` for the one place it *does*
    /// cross to the renderer — the settings-dialog "show password" action,
    /// on demand only). A password held by a locked vault fails the connect
    /// with "vault is locked", which the renderer answers with the unlock
    /// dialog.
    pub async fn proxy_config_for_connect(&self, vault: &Vault) -> Result<JsonMap> {
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
            return Ok(out);
        }
        for key in ["proxyType", "proxyHost", "proxyPort", "proxyUsername"] {
            if let Some(v) = settings.get(key) {
                out.insert(key.into(), v.clone());
            }
        }
        if vault.is_configured() && Self::proxy_password_in_vault(&settings) {
            if let Some(secret) = vault.get_proxy_password().await? {
                let password =
                    String::from_utf8(secret.to_vec()).context("vault secret is not UTF-8")?;
                out.insert("proxyPassword".into(), Value::String(password));
            }
        } else if Self::has_saved_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain") {
            let password =
                Self::decrypt_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain");
            if !password.is_empty() {
                out.insert("proxyPassword".into(), Value::String(password));
            }
        }
        Ok(out)
    }

    /// Resolves the saved proxy password for the settings dialog's "show
    /// password" action. The command's authorization token already required
    /// master-password reauthentication when the vault is configured.
    pub async fn reveal_proxy_password(&self, vault: &Vault) -> Result<Option<String>> {
        let settings = self.get_settings().await;
        if vault.is_configured() && Self::proxy_password_in_vault(&settings) {
            return match vault.get_proxy_password().await? {
                Some(secret) => Ok(Some(
                    String::from_utf8(secret.to_vec()).context("vault secret is not UTF-8")?,
                )),
                None => Ok(None),
            };
        }
        if !Self::has_saved_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain") {
            return Ok(None);
        }
        let secret = Self::decrypt_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain");
        if secret.is_empty() {
            anyhow::bail!("saved proxy password could not be decrypted");
        }
        Ok(Some(secret))
    }

    /// Moves a DPAPI or plaintext proxy password into the vault. Runs on
    /// every unlock, so a password saved while the vault was locked, or
    /// before enhanced protection was turned on, is picked up next time.
    /// An undecryptable value is left in place, as a site's would be.
    pub(crate) async fn migrate_proxy_password_to_vault(&self, vault: &Vault) -> Result<()> {
        let path = self.settings_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut settings: JsonMap = self.read_json(&path, JsonMap::new()).await;
        if !Self::has_saved_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain") {
            return Ok(());
        }
        let mut password =
            Self::decrypt_secret(&settings, "proxyPasswordEnc", "proxyPasswordPlain");
        if password.is_empty() {
            return Ok(());
        }
        let previous = vault.get_proxy_password().await?;
        let applied = vault
            .apply_secret_updates(&[SecretUpdate::SetProxyPassword {
                value: password.as_bytes(),
            }])
            .await;
        password.zeroize();
        applied?;
        settings.remove("proxyPasswordEnc");
        settings.remove("proxyPasswordPlain");
        settings.insert("hasProxyPassword".into(), Value::Bool(true));
        if let Err(error) = self.write_json(&path, &settings).await {
            restore_proxy_password(vault, previous.as_deref())
                .await
                .with_context(|| {
                    format!(
                        "Proxy password migration failed ({error:#}); vault rollback also failed"
                    )
                })?;
            return Err(error).context("committing proxy password migration");
        }
        Ok(())
    }

    /// Copies the vault's proxy password back to DPAPI before the vault is
    /// removed. The vault itself is left untouched, so a failure keeps it
    /// as the source of truth.
    pub(crate) async fn migrate_proxy_password_from_vault(&self, vault: &Vault) -> Result<()> {
        let path = self.settings_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut settings: JsonMap = self.read_json(&path, JsonMap::new()).await;
        let secret: Option<Zeroizing<Vec<u8>>> = vault.get_proxy_password().await?;
        let had_flag = settings.remove("hasProxyPassword").is_some();
        match secret {
            Some(secret) => {
                let protected = Self::protect_secret(&secret)?;
                settings.remove("proxyPasswordPlain");
                settings.insert(
                    "proxyPasswordEnc".into(),
                    Value::String(base64::engine::general_purpose::STANDARD.encode(protected)),
                );
            }
            None if !had_flag => return Ok(()),
            None => {}
        }
        self.write_json(&path, &settings)
            .await
            .context("committing proxy password migration")
    }

    /// Forgets that the vault held a proxy password, after a vault reset.
    pub(crate) async fn clear_proxy_password_flag(&self) -> Result<()> {
        let path = self.settings_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut settings: JsonMap = self.read_json(&path, JsonMap::new()).await;
        if settings.remove("hasProxyPassword").is_none() {
            return Ok(());
        }
        self.write_json(&path, &settings).await
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
            "transferHiddenColumns",
            "showLocalPane",
            "showRemotePane",
            "showTransferQueue",
            "transferQueueHeight",
            // `logEnabled` stays: a reset puts the log panel back to its
            // default size, open or closed as it was.
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

async fn restore_proxy_password(vault: &Vault, previous: Option<&Vec<u8>>) -> Result<()> {
    let update = match previous {
        Some(value) => SecretUpdate::SetProxyPassword { value },
        None => SecretUpdate::DeleteProxyPassword,
    };
    vault.apply_secret_updates(&[update]).await
}
