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
        Some("sites.json" | "settings.json" | "known_hosts.json" | "tabs.json")
    )
}

impl Store {
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
                    let backup = path.with_extension(format!(
                        "corrupt-{}.bak",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0)
                    ));
                    let _ = tokio::fs::copy(path, &backup).await;
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

    pub(super) async fn write_json<T: serde::Serialize>(
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
        let body = serde_json::to_string_pretty(&encode_versioned_store(path, value))?;
        let mut tmp_file = tokio::fs::File::create(&tmp)
            .await
            .context("creating tmp file")?;
        tmp_file
            .write_all(body.as_bytes())
            .await
            .context("writing tmp file")?;
        tmp_file.sync_all().await.context("syncing tmp file")?;
        drop(tmp_file);
        if tokio::fs::read_to_string(path)
            .await
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| decode_versioned_store(path, value).ok())
            .is_some()
        {
            let _ = tokio::fs::copy(path, path.with_extension("last-good.bak")).await;
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
