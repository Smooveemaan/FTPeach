//! Bookmarks moving between installations: the saved secrets an export
//! seals, and an import written as one change of the bookmark files.
use super::mutations::{folder_record, site_record};
use super::*;
use crate::security::credential_scope::{CredentialScope, site_scope};
use tokio::sync::OwnedMutexGuard;
use zeroize::Zeroizing;

/// The secret fields of a bookmark: the vault's name, the DPAPI and legacy
/// plaintext fields in `sites.json`, and the flag that says the vault has it.
const FIELDS: [(&str, &str, &str, &str); 2] = [
    ("password", "enc", "plain", "hasPassword"),
    ("keyPassphrase", "keyEnc", "keyPlain", "hasKeyPassphrase"),
];

/// A bookmark's saved secrets as an export reads them.
#[derive(Default)]
pub(crate) struct SavedSecrets {
    pub password: Option<Zeroizing<String>>,
    pub key_passphrase: Option<Zeroizing<String>>,
}

pub(crate) struct ExportableSecrets {
    pub by_id: HashMap<String, SavedSecrets>,
    /// Bookmarks with a secret this computer cannot open: id and name.
    pub unreadable: Vec<(String, String)>,
}

/// A secret an import brings, with the recipient it was saved for.
pub(crate) struct ImportedSecret {
    pub scope: CredentialScope,
    pub password: Option<SensitiveString>,
    pub key_passphrase: Option<SensitiveString>,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct SitesImported {
    pub added: usize,
    pub skipped: usize,
    /// Passwords and passphrases written.
    pub secrets_saved: usize,
    /// Secrets the vault already held for a bookmark whose flag did not say so.
    pub flags_restored: usize,
    /// Bookmarks whose secret stayed behind: the file now sends the bookmark
    /// somewhere other than where the secret was saved for.
    pub scope_mismatches: Vec<String>,
    /// Already here, but not as exactly one bookmark for the same recipient,
    /// so their secrets had nowhere certain to go.
    pub unmatched: Vec<String>,
}

/// Why an import stopped, and what of the bookmarks and the vault could not
/// be put back as it was.
pub(crate) struct ImportFailed {
    pub error: anyhow::Error,
    pub not_restored: Vec<String>,
}

impl From<anyhow::Error> for ImportFailed {
    fn from(error: anyhow::Error) -> Self {
        Self {
            error,
            not_restored: Vec::new(),
        }
    }
}

/// An import written to the bookmark files, which holds every lock it took
/// until it is kept (dropped) or undone ([`SitesImport::rollback`]), so no
/// other change lands in between and is lost to the undo.
pub(crate) struct SitesImport {
    store: Store,
    vault: Vault,
    _transaction: OwnedMutexGuard<()>,
    _sites: OwnedMutexGuard<()>,
    _local: OwnedMutexGuard<()>,
    /// What each file held before the import, for the files it wrote.
    bookmarks_before: Option<Vec<JsonMap>>,
    local_before: Option<Vec<JsonMap>>,
    /// Vault keys the import filled; each was empty before.
    vault_keys: Vec<(String, &'static str)>,
}

fn name(record: &JsonMap) -> String {
    record
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn kind(record: &JsonMap) -> Option<&str> {
    record.get("kind").and_then(Value::as_str)
}

fn normalize_identity_part(value: &str) -> String {
    value.trim().to_lowercase()
}

/// "Same folder" key: name + `managerScope` (folders are never nested —
/// see [`Store::save_folder`]).
fn folder_identity_key(record: &JsonMap) -> String {
    let scope = record
        .get("managerScope")
        .and_then(Value::as_str)
        .filter(|s| *s == "localPaths")
        .unwrap_or("bookmarks");
    format!("folder|{scope}|{}", normalize_identity_part(&name(record)))
}

/// "Same bookmark" for skipping duplicates. Mirrors `connectionIdentity` in
/// `src/features/sites/siteManagerModel.ts`. Too loose to hand a secret to:
/// that takes the exact recipient, [`site_scope`].
fn site_identity_key(record: &JsonMap) -> String {
    let text = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or("");
    if kind(record) == Some("local") {
        return format!("local|{}", normalize_identity_part(text("localPath")));
    }
    let protocol = text("protocol");
    let address = if protocol == "webdav" {
        text("webdavUrl")
    } else {
        text("host")
    };
    let port = match record.get("port").and_then(Value::as_i64) {
        Some(port) if port != 0 => port.to_string(),
        _ => String::new(),
    };
    format!(
        "{protocol}|{}|{port}|{}",
        normalize_identity_part(address),
        normalize_identity_part(text("user"))
    )
}

impl Store {
    /// Every saved secret of the bookmarks in `sites.json`, from the vault
    /// when it is set up and from DPAPI otherwise.
    pub(crate) async fn secrets_for_export(&self, vault: &Vault) -> Result<ExportableSecrets> {
        self.ensure_storage_split().await?;
        self.migrate_plaintext_secrets().await?;
        let in_vault = vault.is_configured();
        if in_vault && !vault.is_unlocked().await {
            return Err(crate::ipc::vault_locked());
        }
        let sites: Vec<JsonMap> = self.read_json(&self.sites_file(), Vec::new()).await;
        let mut by_id = HashMap::new();
        let mut unreadable = Vec::new();
        for site in &sites {
            let Some(id) = site.get("id").and_then(Value::as_str) else {
                continue;
            };
            if kind(site) == Some("folder") {
                continue;
            }
            let mut secrets = SavedSecrets::default();
            let mut readable = true;
            for (index, (field, enc, plain, _)) in FIELDS.into_iter().enumerate() {
                let value = if in_vault {
                    match vault.get_secret(id, field).await? {
                        Some(bytes) => match std::str::from_utf8(&bytes) {
                            Ok(text) => Some(Zeroizing::new(text.to_owned())),
                            Err(_) => {
                                readable = false;
                                None
                            }
                        },
                        None => None,
                    }
                } else if Self::secret_undecryptable(site, enc) {
                    readable = false;
                    None
                } else {
                    Some(Zeroizing::new(Self::decrypt_secret(site, enc, plain)))
                };
                let value = value.filter(|value| !value.is_empty());
                if index == 0 {
                    secrets.password = value;
                } else {
                    secrets.key_passphrase = value;
                }
            }
            if !readable {
                unreadable.push((id.to_owned(), name(site)));
            } else if secrets.password.is_some() || secrets.key_passphrase.is_some() {
                by_id.insert(id.to_owned(), secrets);
            }
        }
        Ok(ExportableSecrets { by_id, unreadable })
    }

    /// Adds the bookmarks, local paths and folders in `sites` that are not
    /// here yet, and the secrets in `secrets` (keyed by the ids `sites` use)
    /// that have a place to go: an added bookmark, or the only one here for
    /// exactly the recipient the secret was saved for. A secret never
    /// replaces one that is saved already.
    ///
    /// Both bookmark files are written once, after the vault, and stay
    /// locked with the vault's updates until the returned import is kept or
    /// undone.
    pub(crate) async fn import_sites(
        &self,
        vault: &Vault,
        sites: &[JsonMap],
        mut secrets: HashMap<String, ImportedSecret>,
    ) -> std::result::Result<(SitesImported, SitesImport), ImportFailed> {
        let transaction = self.vault_updates.clone().lock_owned().await;
        self.ensure_storage_split().await?;
        let sites_path = self.sites_file();
        let local_path = self.local_paths_file();
        let sites_guard = self.lock_for(&sites_path).await.lock_owned().await;
        let local_guard = self.lock_for(&local_path).await.lock_owned().await;
        self.ensure_writable(&sites_path).await?;
        self.ensure_writable(&local_path).await?;
        let bookmarks_before: Vec<JsonMap> = self.read_json(&sites_path, Vec::new()).await;
        let local_before: Vec<JsonMap> = self.read_json(&local_path, Vec::new()).await;
        let in_vault = vault.is_configured();
        if in_vault && !secrets.is_empty() && !vault.is_unlocked().await {
            return Err(crate::ipc::vault_locked().into());
        }

        let mut bookmarks = bookmarks_before.clone();
        let mut local = local_before.clone();
        let mut outcome = SitesImported::default();
        let mut planned = Vec::new();
        // old id -> (new id, is a localPaths-scope folder) — the scope gates
        // reparenting below (a folder never holds both kinds, see `save_folder`).
        let mut folder_ids: HashMap<String, (String, bool)> = HashMap::new();
        let mut known_folders: HashMap<String, String> = bookmarks
            .iter()
            .chain(&local)
            .filter(|entry| kind(entry) == Some("folder"))
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?;
                Some((folder_identity_key(entry), id.to_owned()))
            })
            .collect();
        let mut known_sites: std::collections::HashSet<String> = bookmarks
            .iter()
            .chain(&local)
            .filter(|entry| kind(entry) != Some("folder"))
            .map(site_identity_key)
            .collect();

        for record in sites.iter().filter(|record| kind(record) == Some("folder")) {
            let old_id = record.get("id").and_then(Value::as_str);
            let is_local_paths =
                record.get("managerScope").and_then(Value::as_str) == Some("localPaths");
            let key = folder_identity_key(record);
            let id = match known_folders.get(&key) {
                Some(existing) => {
                    outcome.skipped += 1;
                    existing.clone()
                }
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let folder = folder_record(record, &id);
                    if is_local_paths {
                        local.push(folder);
                    } else {
                        bookmarks.push(folder);
                    }
                    known_folders.insert(key, id.clone());
                    outcome.added += 1;
                    id
                }
            };
            if let Some(old_id) = old_id {
                folder_ids.insert(old_id.to_owned(), (id, is_local_paths));
            }
        }

        for record in sites.iter().filter(|record| kind(record) != Some("folder")) {
            let is_local = kind(record) == Some("local");
            let secret = record
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| secrets.remove(id))
                .filter(|secret| {
                    let same = secret.scope == site_scope(record);
                    if !same {
                        outcome.scope_mismatches.push(name(record));
                    }
                    same
                });
            let key = site_identity_key(record);
            if known_sites.contains(&key) {
                outcome.skipped += 1;
                let Some(secret) = secret else { continue };
                let matches: Vec<usize> = bookmarks
                    .iter()
                    .enumerate()
                    .filter(|(_, entry)| {
                        kind(entry) != Some("folder") && site_scope(entry) == secret.scope
                    })
                    .map(|(index, _)| index)
                    .collect();
                match matches[..] {
                    [index] => {
                        place_secret(
                            &mut bookmarks[index],
                            &secret,
                            in_vault.then_some(vault),
                            &mut planned,
                            &mut outcome,
                        )
                        .await?;
                    }
                    _ => outcome.unmatched.push(name(record)),
                }
                continue;
            }
            // A legacy export's folder could mix scopes; drop a mismatched
            // parent to root instead of failing the import.
            let parent = record
                .get("parentId")
                .and_then(Value::as_str)
                .and_then(|id| folder_ids.get(id))
                .filter(|(_, folder_is_local_paths)| *folder_is_local_paths == is_local)
                .map(|(new_id, _)| new_id.clone());
            let id = uuid::Uuid::new_v4().to_string();
            let mut entry = site_record(record, &id, parent, None)?;
            if is_local {
                local.push(entry);
            } else {
                for (_, _, _, flag) in FIELDS {
                    entry.insert(flag.into(), Value::Bool(false));
                }
                if let Some(secret) = secret {
                    place_secret(
                        &mut entry,
                        &secret,
                        in_vault.then_some(vault),
                        &mut planned,
                        &mut outcome,
                    )
                    .await?;
                }
                bookmarks.push(entry);
            }
            known_sites.insert(key);
            outcome.added += 1;
        }

        let mut import = SitesImport {
            store: self.clone(),
            vault: vault.clone(),
            _transaction: transaction,
            _sites: sites_guard,
            _local: local_guard,
            bookmarks_before: None,
            local_before: None,
            vault_keys: Vec::new(),
        };
        if !planned.is_empty() {
            let updates: Vec<SecretUpdate> = planned
                .iter()
                .map(|(id, field, value)| SecretUpdate::Set {
                    site_id: id,
                    field,
                    value: value.as_bytes(),
                })
                .collect();
            // All or nothing: a refusal here leaves nothing to undo.
            vault.apply_secret_updates(&updates).await?;
            import.vault_keys = planned
                .into_iter()
                .map(|(id, field, _)| (id, field))
                .collect();
        }
        // ponytail: a crash, or the vault locking itself, between the vault
        // write above and the files below leaves the new ids' secrets in the
        // vault with no bookmark, and a duplicate's without its flag. The next
        // import of the file restores such a flag; a recovery journal and a
        // sweep of orphaned keys if that ever matters.
        // A write that fails leaves its file as it was, so only a file
        // written is one to put back.
        let mut written = Ok(());
        if bookmarks != bookmarks_before {
            written = self.write_json(&sites_path, &bookmarks).await;
            if written.is_ok() {
                import.bookmarks_before = Some(bookmarks_before);
            }
        }
        if written.is_ok() && local != local_before {
            written = self.write_json(&local_path, &local).await;
            if written.is_ok() {
                import.local_before = Some(local_before);
            }
        }
        match written {
            Ok(()) => Ok((outcome, import)),
            Err(error) => Err(ImportFailed {
                error,
                not_restored: import.rollback().await,
            }),
        }
    }
}

/// Gives `entry` the secret wherever it has none: in the vault, where the
/// value is checked rather than the flag (an interrupted write can leave a
/// secret without one), or as a DPAPI field in the entry itself.
async fn place_secret(
    entry: &mut JsonMap,
    secret: &ImportedSecret,
    vault: Option<&Vault>,
    planned: &mut Vec<(String, &'static str, Zeroizing<String>)>,
    outcome: &mut SitesImported,
) -> Result<()> {
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    for ((field, enc, plain, flag), value) in FIELDS
        .into_iter()
        .zip([&secret.password, &secret.key_passphrase])
    {
        let Some(value) = value.as_ref().filter(|value| !value.is_empty()) else {
            continue;
        };
        match vault {
            Some(vault) => {
                let saved = planned.iter().any(|(planned_id, planned_field, _)| {
                    *planned_id == id && *planned_field == field
                }) || vault.get_secret(&id, field).await?.is_some();
                if !saved {
                    planned.push((id.clone(), field, Zeroizing::new(value.expose().to_owned())));
                    outcome.secrets_saved += 1;
                } else if entry.get(flag) != Some(&Value::Bool(true)) {
                    outcome.flags_restored += 1;
                }
                entry.insert(flag.into(), Value::Bool(true));
            }
            None if Store::has_saved_secret(entry, enc, plain) => {}
            None => {
                let protected = Store::protect_secret(value.expose().as_bytes())
                    .context("protecting an imported password")?;
                entry.insert(
                    enc.into(),
                    Value::String(base64::engine::general_purpose::STANDARD.encode(protected)),
                );
                entry.insert(flag.into(), Value::Bool(true));
                outcome.secrets_saved += 1;
            }
        }
    }
    Ok(())
}

impl SitesImport {
    /// Undoes the import: removes the secrets it put in the vault and writes
    /// back each bookmark file it changed. Every step is tried whatever the
    /// one before did; what could not be undone is returned.
    pub(crate) async fn rollback(self) -> Vec<String> {
        let mut not_restored = Vec::new();
        if !self.vault_keys.is_empty() {
            let deletes: Vec<SecretUpdate> = self
                .vault_keys
                .iter()
                .map(|(id, field)| SecretUpdate::Delete { site_id: id, field })
                .collect();
            if let Err(error) = self.vault.apply_secret_updates(&deletes).await {
                not_restored.push(format!(
                    "The imported passwords could not be removed from the vault: {error:#}"
                ));
            }
        }
        for (path, before) in [
            (self.store.sites_file(), &self.bookmarks_before),
            (self.store.local_paths_file(), &self.local_before),
        ] {
            if let Some(before) = before
                && let Err(error) = self.store.write_json(&path, before).await
            {
                not_restored.push(format!(
                    "{} could not be restored: {error:#}",
                    path.display()
                ));
            }
        }
        not_restored
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
