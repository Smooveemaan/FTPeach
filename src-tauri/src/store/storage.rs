//! Versioned JSON persistence and observable recovery for user preferences.
//! Unsupported schemas and unreadable stores remain read-only. Critical SSH
//! trust reads use the separate fail-closed known-hosts contract.

use super::Store;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

pub(super) const STORAGE_SCHEMA_VERSION: u64 = 1;

/// Version 1 wraps the store payload so future changes can be migrated
/// deterministically; schema 0 (a bare JSON array/object, still present on
/// disk from older installs) is read transparently.
/// The compatibility boundary deliberately remains `Value`: application code
/// receives the same payload shape while only this module understands legacy
/// on-disk representations.
pub(super) fn decode_versioned_store(path: &Path, value: Value) -> Result<Value> {
    let Some(object) = value.as_object() else {
        return Ok(value);
    };
    let Some(version) = object.get("schemaVersion") else {
        // A bare settings/known-hosts object is also schema 0.
        return Ok(value);
    };
    let looks_like_envelope = is_versioned_store(path)
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with("sites.")
                    || name.starts_with("settings.")
                    || name.starts_with("known_hosts.")
                    || name.starts_with("tabs.")
                    || name.starts_with("local-paths.")
            });
    if !looks_like_envelope {
        return Ok(value);
    }
    let version = version
        .as_u64()
        .context("schemaVersion must be a non-negative integer")?;
    match version {
        STORAGE_SCHEMA_VERSION => object
            .get("data")
            .cloned()
            .context("versioned store is missing data"),
        other => {
            anyhow::bail!(
                "unsupported {} schema version {other} (maximum supported: {STORAGE_SCHEMA_VERSION})",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("store")
            )
        }
    }
}

pub(super) fn encode_versioned_store(path: &Path, value: Value) -> Value {
    if is_versioned_store(path) {
        json!({"schemaVersion": STORAGE_SCHEMA_VERSION, "data": value})
    } else {
        value
    }
}

fn is_versioned_store(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(
            "sites.json" | "settings.json" | "known_hosts.json" | "tabs.json" | "local-paths.json"
        )
    )
}

/// Fields that hold a saved secret, protected or not.
const SECRET_FIELDS: [&str; 6] = [
    "enc",
    "plain",
    "keyEnc",
    "keyPlain",
    "proxyPasswordEnc",
    "proxyPasswordPlain",
];
const PLAINTEXT_FIELDS: [&str; 3] = ["plain", "keyPlain", "proxyPasswordPlain"];

/// `previous`, fit to be kept as a backup of a store that now holds `next`.
/// A secret survives only where `next` holds the very same value, so a
/// backup never keeps a secret the live file has moved into the vault,
/// replaced or deleted, and never keeps plaintext at all.
pub(super) fn backup_without_stale_secrets(previous: Value, next: &Value) -> Value {
    fn strip(mut record: Value, counterpart: Option<&Value>) -> Value {
        if let Value::Object(fields) = &mut record {
            for field in SECRET_FIELDS {
                let still_live = !PLAINTEXT_FIELDS.contains(&field)
                    && counterpart.and_then(|next| next.get(field)) == fields.get(field);
                if !still_live {
                    fields.remove(field);
                }
            }
        }
        record
    }
    match previous {
        Value::Array(records) => Value::Array(
            records
                .into_iter()
                .map(|record| {
                    let counterpart = record.get("id").and_then(|id| {
                        next.as_array()?
                            .iter()
                            .find(|candidate| candidate.get("id") == Some(id))
                    });
                    strip(record, counterpart)
                })
                .collect(),
        ),
        record => strip(record, Some(next)),
    }
}

/// Writes `body` to `tmp`, flushes it and renames it over `target`, so a
/// reader sees either the old file or the complete new one.
async fn publish(tmp: &Path, target: &Path, body: &[u8]) -> Result<()> {
    let written = async {
        let mut file = tokio::fs::File::create(tmp).await?;
        file.write_all(body).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(tmp, target).await
    }
    .await;
    if written.is_err() {
        let _ = tokio::fs::remove_file(tmp).await;
    }
    Ok(written?)
}

/// Replaces `path`'s last-good backup with `backup`, atomically.
async fn write_backup(path: &Path, backup: Value) -> Result<()> {
    let target = path.with_extension("last-good.bak");
    let tmp = path.with_extension(format!("last-good.{}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(&encode_versioned_store(path, backup))?;
    publish(&tmp, &target, body.as_bytes()).await
}

/// Corrupt copies kept per store; older ones are deleted.
const CORRUPT_COPIES_KEPT: usize = 5;

/// Keeps `raw`, the unreadable contents of `path`, as
/// `<store>.corrupt-<hash>.bak`. The name follows the content, so reading
/// the same broken file again adds nothing, and only the newest
/// [`CORRUPT_COPIES_KEPT`] copies of a store are kept.
async fn archive_corrupt(path: &Path, raw: &[u8]) -> Result<()> {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(raw)[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let target = path.with_extension(format!("corrupt-{hash}.bak"));
    if tokio::fs::try_exists(&target).await? {
        return Ok(());
    }
    let tmp = path.with_extension(format!("corrupt-{hash}.{}.tmp", std::process::id()));
    publish(&tmp, &target, raw).await?;

    let prefix = format!("{}.corrupt-", store_name(path));
    let mut copies = Vec::new();
    let mut entries = tokio::fs::read_dir(path.parent().unwrap_or(Path::new("."))).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".bak") {
            copies.push((entry.metadata().await?.modified()?, entry.path()));
        }
    }
    copies.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, stale) in copies.into_iter().skip(CORRUPT_COPIES_KEPT) {
        tokio::fs::remove_file(stale).await?;
    }
    Ok(())
}

fn store_name(path: &Path) -> &str {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("store")
}

/// Temporary files this module names `<store>.<pid>.<millis>.tmp`,
/// `<store>.last-good.<pid>.tmp` or `<store>.corrupt-<hash>.<pid>.tmp`, with
/// the pid that wrote them.
fn store_tmp_pid(name: &str) -> Option<u32> {
    let stem = name.strip_suffix(".tmp")?;
    let mut parts = stem.split('.');
    let store = parts.next()?;
    if !matches!(
        store,
        "sites" | "settings" | "tabs" | "known_hosts" | "local-paths"
    ) {
        return None;
    }
    let rest: Vec<&str> = parts.collect();
    match rest.as_slice() {
        [pid, millis] if millis.bytes().all(|b| b.is_ascii_digit()) => pid.parse().ok(),
        ["last-good", pid] => pid.parse().ok(),
        [copy, pid] if copy.starts_with("corrupt-") => pid.parse().ok(),
        _ => None,
    }
}

impl Store {
    /// Brings backups in line with the live stores, for installs that wrote
    /// them before backups followed the live file's protection: rewrites
    /// each last-good backup without stale or plaintext secrets, drops the
    /// pre-vault copy of `sites.json` unless a migration is still running,
    /// and removes temporary files an earlier run left behind. Corrupt-file
    /// copies are kept verbatim for manual recovery.
    pub async fn scrub_secret_backups(&self) {
        for name in ["sites.json", "settings.json"] {
            let path = self.dir.join(name);
            let lock = self.lock_for(&path).await;
            let _guard = lock.lock().await;
            let read = |path: PathBuf| async move {
                let raw = tokio::fs::read_to_string(&path).await.ok()?;
                decode_versioned_store(&path, serde_json::from_str(&raw).ok()?).ok()
            };
            let (Some(live), Some(backup)) = (
                read(path.clone()).await,
                read(path.with_extension("last-good.bak")).await,
            ) else {
                continue;
            };
            let scrubbed = backup_without_stale_secrets(backup.clone(), &live);
            if scrubbed != backup
                && let Err(error) = write_backup(&path, scrubbed).await
            {
                log::warn!("Could not scrub the {name} backup: {error:#}");
            }
        }

        // Earlier versions removed the migration marker but not its backup,
        // which then came back as a "recovered" marker on every read.
        let marker = self.dir.join("vault-migration.json");
        if !tokio::fs::try_exists(&marker).await.unwrap_or(true) {
            let _ = tokio::fs::remove_file(marker.with_extension("last-good.bak")).await;
        }

        let migration: Value = tokio::fs::read_to_string(&marker)
            .await
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        let migrating = decode_versioned_store(Path::new("vault-migration.json"), migration)
            .ok()
            .and_then(|value| value.get("status").cloned())
            == Some(Value::String("inProgress".into()));
        if !migrating {
            match tokio::fs::remove_file(self.dir.join("sites.pre-stronghold.bak")).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log::warn!("Could not remove the pre-vault backup: {error}"),
            }
        }

        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            if let Some(pid) = name.to_str().and_then(store_tmp_pid)
                && pid != std::process::id()
            {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    fn storage_issue(&self, path: &Path, message: String, blocked: bool) {
        log::warn!("Store {}: {message}", path.display());
        self.storage_issues
            .lock()
            .unwrap()
            .insert(path.to_owned(), (message, blocked));
    }

    pub fn storage_warnings(&self) -> Vec<String> {
        self.storage_issues
            .lock()
            .unwrap()
            .iter()
            .map(|(path, (reason, _))| {
                format!(
                    "{}: {reason}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                )
            })
            .collect()
    }

    pub(super) async fn ensure_writable(&self, path: &Path) -> Result<()> {
        if let Some((reason, true)) = self.storage_issues.lock().unwrap().get(path) {
            anyhow::bail!("Store is read-only: {reason}");
        }
        match tokio::fs::read_to_string(path).await {
            Ok(raw) => {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    decode_versioned_store(path, value)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("refusing to overwrite unreadable store"),
        }
        Ok(())
    }

    pub(super) async fn read_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &PathBuf,
        fallback: T,
    ) -> T {
        match tokio::fs::read_to_string(path).await {
            Ok(raw) => match serde_json::from_str::<Value>(&raw)
                .context("parsing JSON")
                .and_then(|value| decode_versioned_store(path, value))
                .and_then(|value| serde_json::from_value(value).context("decoding store payload"))
            {
                Ok(value) => value,
                Err(error) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&raw)
                        && decode_versioned_store(path, value).is_err()
                    {
                        self.storage_issue(path, format!("{error:#}"), true);
                        return fallback;
                    }
                    self.storage_issue(
                        path,
                        format!("{error:#}; last-good recovery unavailable"),
                        true,
                    );
                    if let Err(error) = archive_corrupt(path, raw.as_bytes()).await {
                        log::warn!(
                            "Could not keep a copy of the unreadable {}: {error:#}",
                            path.display()
                        );
                    }
                    let last_good = path.with_extension("last-good.bak");
                    match tokio::fs::read_to_string(&last_good).await {
                        Ok(raw) => serde_json::from_str::<Value>(&raw)
                            .context("parsing last-good JSON")
                            .and_then(|value| decode_versioned_store(&last_good, value))
                            .and_then(|value| {
                                serde_json::from_value(value).context("decoding last-good payload")
                            })
                            .inspect(|_| {
                                self.storage_issue(
                                    path,
                                    "Recovered from last-good backup".into(),
                                    false,
                                );
                            })
                            .unwrap_or(fallback),
                        Err(_) => fallback,
                    }
                }
            },
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    self.storage_issue(path, error.to_string(), true);
                } else {
                    let backup = path.with_extension("last-good.bak");
                    match tokio::fs::read_to_string(&backup).await {
                        Ok(raw) => {
                            let recovered = serde_json::from_str::<Value>(&raw)
                                .context("parsing last-good JSON")
                                .and_then(|value| decode_versioned_store(&backup, value))
                                .and_then(|value| {
                                    serde_json::from_value(value)
                                        .context("decoding last-good payload")
                                });
                            match recovered {
                                Ok(value) => {
                                    self.storage_issue(
                                        path,
                                        "Main store missing; recovered from last-good backup"
                                            .into(),
                                        false,
                                    );
                                    return value;
                                }
                                Err(error) => self.storage_issue(path, format!("{error:#}"), true),
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => self.storage_issue(path, error.to_string(), true),
                    }
                }
                fallback
            }
        }
    }

    /// Replaces `path` with `data`. The previous contents become the
    /// last-good backup only if they still decode as a `T`, so a file of the
    /// wrong shape never displaces a backup that could be recovered.
    pub(super) async fn write_json<T: serde::Serialize + serde::de::DeserializeOwned>(
        &self,
        path: &PathBuf,
        data: &T,
    ) -> Result<()> {
        self.ensure_writable(path).await?;
        tokio::fs::create_dir_all(&self.dir)
            .await
            .context("creating the settings store directory")?;
        let tmp = path.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let value = serde_json::to_value(data)?;
        let body = serde_json::to_string_pretty(&encode_versioned_store(path, value.clone()))?;
        let mut tmp_file = tokio::fs::File::create(&tmp)
            .await
            .context("creating tmp file")?;
        tmp_file
            .write_all(body.as_bytes())
            .await
            .context("writing tmp file")?;
        tmp_file.sync_all().await.context("syncing tmp file")?;
        drop(tmp_file);
        if let Some(previous) = tokio::fs::read_to_string(path)
            .await
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| decode_versioned_store(path, value).ok())
            .filter(|previous| serde_json::from_value::<T>(previous.clone()).is_ok())
            && let Err(error) =
                write_backup(path, backup_without_stale_secrets(previous, &value)).await
        {
            self.storage_issue(
                path,
                format!("last-good backup not updated: {error:#}"),
                false,
            );
        }
        if let Err(error) = tokio::fs::rename(&tmp, path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(error).context("renaming tmp file into place");
        }
        Ok(())
    }

    pub(super) async fn lock_for(&self, path: &Path) -> Arc<AsyncMutex<()>> {
        let mut locks = self.write_locks.lock().unwrap();
        locks
            .entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}
