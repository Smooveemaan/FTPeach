use super::*;

impl Store {
    pub(super) fn sites_file(&self) -> PathBuf {
        self.dir.join("sites.json")
    }

    /// Raw rollback snapshot: public listings intentionally strip secrets.
    pub(crate) async fn snapshot_sites_for_import(&self) -> Result<Vec<JsonMap>> {
        self.ensure_storage_split().await?;
        let mut snapshot = Vec::new();
        for path in [self.sites_file(), self.local_paths_file()] {
            let entries: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
            self.ensure_writable(&path).await?;
            snapshot.extend(entries);
        }
        Ok(snapshot)
    }
    /// Local-path bookmarks and their folders. See `ensure_storage_split`.
    pub(super) fn local_paths_file(&self) -> PathBuf {
        self.dir.join("local-paths.json")
    }
    fn vault_migration_file(&self) -> PathBuf {
        self.dir.join("vault-migration.json")
    }

    /// One-time split of legacy `sites.json` into `sites.json` (bookmarks)
    /// and `local_paths_file()` (local paths). No-op once already split.
    pub(super) async fn ensure_storage_split(&self) -> Result<()> {
        let path = self.sites_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        if !sites.iter().any(is_local_scope_entry) {
            return Ok(());
        }
        let (local, bookmarks): (Vec<JsonMap>, Vec<JsonMap>) =
            sites.into_iter().partition(is_local_scope_entry);

        let local_path = self.local_paths_file();
        let local_lock = self.lock_for(&local_path).await;
        let _local_guard = local_lock.lock().await;
        let mut merged_local: Vec<JsonMap> = self.read_json(&local_path, Vec::new()).await;
        let existing_ids: std::collections::HashSet<String> = merged_local
            .iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        merged_local.extend(local.into_iter().filter(|entry| {
            !entry
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| existing_ids.contains(id))
        }));
        self.write_json(&local_path, &merged_local).await?;
        self.write_json(&path, &bookmarks).await
    }

    pub async fn has_undecryptable_secret(&self) -> bool {
        let sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        sites.iter().any(|site| {
            Self::secret_undecryptable(site, "enc") || Self::secret_undecryptable(site, "keyEnc")
        })
    }

    /// The sites-domain half of `has_plaintext_secret` — see mod.rs, which
    /// also checks the global proxy password.
    pub(crate) async fn sites_have_plaintext_secret(&self) -> bool {
        let sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        sites.iter().any(|site| {
            Self::secret_is_plaintext(site, "plain") || Self::secret_is_plaintext(site, "keyPlain")
        })
    }

    pub(crate) async fn migrate_plaintext_secrets_with<F>(&self, protect: F) -> Result<()>
    where
        F: Fn(&[u8]) -> Result<Vec<u8>> + Copy,
    {
        let path = self.sites_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        let mut changed = false;

        for site in &mut sites {
            changed |= Self::migrate_plaintext_field(site, "plain", "enc", protect);
            changed |= Self::migrate_plaintext_field(site, "keyPlain", "keyEnc", protect);
        }

        if changed {
            self.write_json(&path, &sites).await?;
        }
        Ok(())
    }

    async fn migrate_plaintext_secrets(&self) -> Result<()> {
        self.migrate_plaintext_secrets_with(Self::protect_secret)
            .await
    }

    // ---------- sites ----------

    pub async fn list_sites(&self) -> Result<Vec<JsonMap>> {
        self.ensure_storage_split().await?;
        self.migrate_plaintext_secrets().await?;
        let mut sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        sites.extend(
            self.read_json::<Vec<JsonMap>>(&self.local_paths_file(), Vec::new())
                .await,
        );
        Ok(sites
            .into_iter()
            .map(|site| {
                if site.get("kind").and_then(|v| v.as_str()) == Some("folder") {
                    let mut out = JsonMap::new();
                    let get = |k: &str| site.get(k).cloned().unwrap_or(Value::Null);
                    out.insert("id".into(), get("id"));
                    out.insert("kind".into(), Value::String("folder".into()));
                    out.insert("name".into(), get("name"));
                    out.insert("parentId".into(), get("parentId"));
                    out.insert("managerScope".into(), get("managerScope"));
                    return out;
                }
                if site.get("kind").and_then(Value::as_str) == Some("local") {
                    let mut out = JsonMap::new();
                    let get = |key: &str| site.get(key).cloned().unwrap_or(Value::Null);
                    out.insert("id".into(), get("id"));
                    out.insert("kind".into(), Value::String("local".into()));
                    out.insert("name".into(), get("name"));
                    out.insert("localPath".into(), get("localPath"));
                    out.insert("parentId".into(), get("parentId"));
                    out.insert("icon".into(), get("icon"));
                    out.insert("color".into(), get("color"));
                    return out;
                }
                let mut out = JsonMap::new();
                let get = |k: &str| site.get(k).cloned().unwrap_or(Value::Null);
                out.insert("id".into(), get("id"));
                out.insert("kind".into(), Value::String("site".into()));
                out.insert("parentId".into(), get("parentId"));
                out.insert("name".into(), get("name"));
                out.insert("icon".into(), get("icon"));
                out.insert("color".into(), get("color"));
                out.insert("protocol".into(), get("protocol"));
                out.insert("host".into(), get("host"));
                out.insert("port".into(), get("port"));
                out.insert(
                    "webdavUrl".into(),
                    Value::String(
                        site.get("webdavUrl")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .into(),
                    ),
                );
                out.insert("user".into(), get("user"));
                out.insert(
                    "secure".into(),
                    Value::Bool(
                        site.get("secure")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    ),
                );
                out.insert(
                    "allowInvalidCert".into(),
                    Value::Bool(
                        site.get("allowInvalidCert")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    ),
                );
                out.insert(
                    "remotePath".into(),
                    Value::String(
                        site.get("remotePath")
                            .and_then(|v| v.as_str())
                            .unwrap_or("/")
                            .into(),
                    ),
                );
                out.insert(
                    "hasPassword".into(),
                    Value::Bool(
                        site.get("hasPassword")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                            || Self::has_saved_secret(&site, "enc", "plain"),
                    ),
                );
                out.insert(
                    "useKeyAuth".into(),
                    Value::Bool(
                        site.get("useKeyAuth")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    ),
                );
                out.insert(
                    "keyPath".into(),
                    Value::String(
                        site.get("keyPath")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .into(),
                    ),
                );
                out.insert(
                    "caCertPath".into(),
                    Value::String(
                        site.get("caCertPath")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .into(),
                    ),
                );
                out.insert(
                    "hasKeyPassphrase".into(),
                    Value::Bool(
                        site.get("hasKeyPassphrase")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                            || Self::has_saved_secret(&site, "keyEnc", "keyPlain"),
                    ),
                );
                out
            })
            .collect())
    }

    /// Re-split a raw import/rollback snapshot into the two manager files.
    pub(crate) async fn replace_sites_for_import(&self, sites: &[JsonMap]) -> Result<()> {
        let (local, bookmarks): (Vec<JsonMap>, Vec<JsonMap>) =
            sites.iter().cloned().partition(is_local_scope_entry);

        let path = self.sites_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let local_path = self.local_paths_file();
        let local_lock = self.lock_for(&local_path).await;
        let _local_guard = local_lock.lock().await;
        self.ensure_writable(&path).await?;
        self.ensure_writable(&local_path).await?;
        self.write_json(&path, &bookmarks).await?;
        self.write_json(&local_path, &local).await
    }

    pub async fn connection_config_for_site(&self, id: &str) -> Result<JsonMap> {
        self.migrate_plaintext_secrets().await?;
        let sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        let site = sites
            .into_iter()
            .find(|site| {
                site.get("kind").and_then(Value::as_str) != Some("folder")
                    && site.get("id").and_then(Value::as_str) == Some(id)
            })
            .context("saved site not found")?;

        let mut config = site.clone();
        config.remove("enc");
        config.remove("plain");
        config.remove("keyEnc");
        config.remove("keyPlain");
        config.insert(
            "password".into(),
            Value::String(Self::decrypt_secret(&site, "enc", "plain")),
        );
        config.insert(
            "keyPassphrase".into(),
            Value::String(Self::decrypt_secret(&site, "keyEnc", "keyPlain")),
        );
        Ok(config)
    }

    /// Returns one DPAPI-protected saved secret for the connection editor.
    /// Stronghold secrets never pass through this path.
    pub async fn reveal_dpapi_secret(&self, id: &str, field: &str) -> Result<Option<String>> {
        let (encrypted_field, plaintext_field) = match field {
            "password" => ("enc", "plain"),
            "keyPassphrase" => ("keyEnc", "keyPlain"),
            _ => anyhow::bail!("unsupported secret field"),
        };
        self.migrate_plaintext_secrets().await?;
        let sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        let site = sites
            .iter()
            .find(|site| site.get("id").and_then(Value::as_str) == Some(id))
            .context("saved site not found")?;
        if !Self::has_saved_secret(site, encrypted_field, plaintext_field) {
            return Ok(None);
        }
        let secret = Self::decrypt_secret(site, encrypted_field, plaintext_field);
        if secret.is_empty() {
            anyhow::bail!("saved secret could not be decrypted");
        }
        Ok(Some(secret))
    }

    pub async fn connection_config_for_site_with_vault(
        &self,
        id: &str,
        vault: &Vault,
    ) -> Result<JsonMap> {
        if !vault.is_configured() {
            return self.connection_config_for_site(id).await;
        }
        let mut config = self.connection_config_for_site(id).await?;
        for (field, output) in [("password", "password"), ("keyPassphrase", "keyPassphrase")] {
            let secret = vault.get_secret(id, field).await?;
            let value = match secret {
                Some(bytes) => {
                    String::from_utf8(bytes.to_vec()).context("vault secret is not UTF-8")?
                }
                None => String::new(),
            };
            config.insert(output.into(), Value::String(value));
        }
        Ok(config)
    }

    pub async fn save_site_with_vault(
        &self,
        input: JsonMap,
        vault: &Vault,
    ) -> Result<SaveSiteOutcome> {
        let store = self.clone();
        let vault = vault.clone();
        tokio::spawn(async move {
            let _transaction = store.vault_updates.lock().await;
            store.save_site_with_vault_inner(input, &vault).await
        })
        .await
        .context("site save task failed")?
    }

    async fn save_site_with_vault_inner(
        &self,
        mut input: JsonMap,
        vault: &Vault,
    ) -> Result<SaveSiteOutcome> {
        if !vault.is_configured() {
            return self.save_site(input).await;
        }
        if !vault.is_unlocked().await {
            anyhow::bail!("vault is locked");
        }

        let id = input
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        input.insert("id".into(), Value::String(id.clone()));

        validate_site_input(&input)?;
        self.snapshot_sites_for_import().await?;
        let sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        let existing = sites
            .iter()
            .find(|site| site.get("id").and_then(Value::as_str) == Some(&id));
        let mut has_password = existing.is_some_and(|site| {
            site.get("hasPassword")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || Self::has_saved_secret(site, "enc", "plain")
        });
        let mut has_key_passphrase = existing.is_some_and(|site| {
            site.get("hasKeyPassphrase")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || Self::has_saved_secret(site, "keyEnc", "keyPlain")
        });

        let password = input
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes();
        let key_passphrase = input
            .get("keyPassphrase")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes();
        let remove_password = input
            .get("removePassword")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let remove_key = input
            .get("removeKeyPassphrase")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut updates = Vec::new();
        if remove_password {
            updates.push(SecretUpdate::Delete {
                site_id: &id,
                field: "password",
            });
            has_password = false;
        } else if !password.is_empty() {
            updates.push(SecretUpdate::Set {
                site_id: &id,
                field: "password",
                value: password,
            });
            has_password = true;
        }
        if remove_key {
            updates.push(SecretUpdate::Delete {
                site_id: &id,
                field: "keyPassphrase",
            });
            has_key_passphrase = false;
        } else if !key_passphrase.is_empty() {
            updates.push(SecretUpdate::Set {
                site_id: &id,
                field: "keyPassphrase",
                value: key_passphrase,
            });
            has_key_passphrase = true;
        }
        let old_password = vault.get_secret(&id, "password").await?;
        let old_key = vault.get_secret(&id, "keyPassphrase").await?;
        vault.apply_secret_updates(&updates).await?;

        input.insert("password".into(), Value::String(String::new()));
        input.insert("keyPassphrase".into(), Value::String(String::new()));
        input.insert("removePassword".into(), Value::Bool(true));
        input.insert("removeKeyPassphrase".into(), Value::Bool(true));
        input.insert("hasPassword".into(), Value::Bool(has_password));
        input.insert("hasKeyPassphrase".into(), Value::Bool(has_key_passphrase));
        match self.save_site(input).await {
            Ok(saved) => Ok(saved),
            Err(error) => {
                restore_secrets(vault, &id, old_password.as_deref(), old_key.as_deref())
                    .await
                    .with_context(|| {
                        format!("Site save failed ({error:#}); vault rollback also failed")
                    })?;
                Err(error)
            }
        }
    }

    pub async fn migrate_secrets_to_vault(&self, vault: &Vault) -> Result<usize> {
        if !vault.is_configured() || !vault.is_unlocked().await {
            anyhow::bail!("vault is locked");
        }
        let migration: JsonMap = self
            .read_json(&self.vault_migration_file(), JsonMap::new())
            .await;
        if migration.get("status").and_then(Value::as_str) == Some("complete") {
            return Ok(0);
        }
        self.migrate_plaintext_secrets().await?;
        if self.sites_have_plaintext_secret().await {
            anyhow::bail!("plaintext secrets could not be protected before vault migration");
        }
        let path = self.sites_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        let mut migrated = 0usize;

        let has_legacy = sites.iter().any(|site| {
            Self::has_saved_secret(site, "enc", "plain")
                || Self::has_saved_secret(site, "keyEnc", "keyPlain")
        });
        let backup = self.dir.join("sites.pre-stronghold.bak");
        if has_legacy && !backup.exists() && path.exists() {
            tokio::fs::copy(&path, &backup)
                .await
                .context("backing up sites before vault migration")?;
        }
        if has_legacy {
            self.write_json(
                &self.vault_migration_file(),
                &json!({ "version": 1, "status": "inProgress" }),
            )
            .await?;
        }

        for site in &mut sites {
            let Some(id) = site.get("id").and_then(Value::as_str).map(str::to_owned) else {
                continue;
            };
            if site.get("kind").and_then(Value::as_str) == Some("folder") {
                continue;
            }
            let mut password = Self::decrypt_secret(site, "enc", "plain");
            let mut key_passphrase = Self::decrypt_secret(site, "keyEnc", "keyPlain");
            let mut updates = Vec::new();
            if !password.is_empty() {
                updates.push(SecretUpdate::Set {
                    site_id: &id,
                    field: "password",
                    value: password.as_bytes(),
                });
            }
            if !key_passphrase.is_empty() {
                updates.push(SecretUpdate::Set {
                    site_id: &id,
                    field: "keyPassphrase",
                    value: key_passphrase.as_bytes(),
                });
            }
            if updates.is_empty() {
                continue;
            }
            vault.apply_secret_updates(&updates).await?;
            if !password.is_empty() {
                site.insert("hasPassword".into(), Value::Bool(true));
                site.remove("enc");
                site.remove("plain");
            }
            if !key_passphrase.is_empty() {
                site.insert("hasKeyPassphrase".into(), Value::Bool(true));
                site.remove("keyEnc");
                site.remove("keyPlain");
            }
            password.zeroize();
            key_passphrase.zeroize();
            migrated += 1;
        }
        if migrated > 0
            && let Err(error) = self.write_json(&path, &sites).await
        {
            if backup.exists() {
                let original: Vec<JsonMap> = self.read_json(&backup, Vec::new()).await;
                let _ = self.write_json(&path, &original).await;
            }
            return Err(error).context("committing Stronghold migration");
        }
        if has_legacy {
            self.write_json(
                &self.vault_migration_file(),
                &json!({ "version": 1, "status": "complete" }),
            )
            .await?;
        }
        Ok(migrated)
    }

    /// Copies every Stronghold secret to DPAPI and commits sites.json once.
    /// The caller removes Stronghold only after this succeeds, so a failed
    /// migration always leaves the original vault intact.
    pub async fn migrate_secrets_from_vault(&self, vault: &Vault) -> Result<usize> {
        if !vault.is_configured() || !vault.is_unlocked().await {
            anyhow::bail!("vault is locked");
        }
        let path = self.sites_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        let mut migrated = 0usize;
        for site in &mut sites {
            if site.get("kind").and_then(Value::as_str) == Some("folder") {
                continue;
            }
            let Some(id) = site.get("id").and_then(Value::as_str).map(str::to_owned) else {
                continue;
            };
            let mut changed = false;
            for (vault_field, disk_field, flag) in [
                ("password", "enc", "hasPassword"),
                ("keyPassphrase", "keyEnc", "hasKeyPassphrase"),
            ] {
                match vault.get_secret(&id, vault_field).await? {
                    Some(mut secret) => {
                        let protected = Self::protect_secret(&secret)?;
                        secret.zeroize();
                        site.insert(
                            disk_field.into(),
                            Value::String(
                                base64::engine::general_purpose::STANDARD.encode(protected),
                            ),
                        );
                        site.remove(flag);
                        changed = true;
                    }
                    _ => {
                        site.remove(flag);
                    }
                }
            }
            if changed {
                migrated += 1;
            }
        }
        self.write_json(&path, &sites).await?;
        Ok(migrated)
    }

    pub async fn clear_vault_secret_flags(&self) -> Result<()> {
        let path = self.sites_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        for site in &mut sites {
            site.remove("hasPassword");
            site.remove("hasKeyPassphrase");
        }
        self.write_json(&path, &sites).await?;
        match tokio::fs::remove_file(self.vault_migration_file()).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("removing vault migration marker"),
        }
    }
    pub async fn delete_site_with_vault(&self, id: String, vault: &Vault) -> Result<()> {
        let store = self.clone();
        let vault = vault.clone();
        tokio::spawn(async move {
            let _transaction = store.vault_updates.lock().await;
            if !vault.is_configured() {
                return store.delete_site(&id).await;
            }
            let _snapshot = store.snapshot_sites_for_import().await?;
            let old_password = vault.get_secret(&id, "password").await?;
            let old_key = vault.get_secret(&id, "keyPassphrase").await?;
            vault
                .apply_secret_updates(&[
                    SecretUpdate::Delete {
                        site_id: &id,
                        field: "password",
                    },
                    SecretUpdate::Delete {
                        site_id: &id,
                        field: "keyPassphrase",
                    },
                ])
                .await?;
            if let Err(error) = store.delete_site(&id).await {
                restore_secrets(&vault, &id, old_password.as_deref(), old_key.as_deref())
                    .await
                    .with_context(|| {
                        format!("Site deletion failed ({error:#}); vault rollback also failed")
                    })?;
                return Err(error);
            }
            Ok(())
        })
        .await
        .context("site deletion task failed")?
    }
}

async fn restore_secrets(
    vault: &Vault,
    id: &str,
    password: Option<&Vec<u8>>,
    key: Option<&Vec<u8>>,
) -> Result<()> {
    let updates =
        [("password", password), ("keyPassphrase", key)].map(|(field, value)| match value {
            Some(value) => SecretUpdate::Set {
                site_id: id,
                field,
                value,
            },
            None => SecretUpdate::Delete { site_id: id, field },
        });
    vault.apply_secret_updates(&updates).await
}
