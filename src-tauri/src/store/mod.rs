mod known_hosts;
mod secret_fields;
pub(crate) use secret_fields::{PROXY_SAVED, SITE_INPUT, SITE_SAVED, proxy_secret_fields};
mod settings;
pub use settings::ConnectionDefaults;
mod settings_schema;
pub(crate) use settings_schema::validate_settings;
mod sites;
mod storage;
pub(crate) use storage::write_synced;
pub use storage::{StorageIssue, StorageWarning};
mod tabs;
mod trusted_applications;

pub(crate) use sites::{
    ImportFailed, ImportedSecret, SitesImported, is_local_scope_entry, validate_site_input,
};

use anyhow::{Context, Result};
use serde_json::Map;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

pub type JsonMap = Map<String, serde_json::Value>;

#[derive(Clone)]
pub struct Store {
    dir: PathBuf,
    vault_updates: Arc<AsyncMutex<()>>,
    storage_issues: Arc<std::sync::Mutex<HashMap<PathBuf, (StorageIssue, String)>>>,
    write_locks: Arc<std::sync::Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>>,
}

impl Store {
    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    pub fn new() -> Result<Self> {
        Ok(Self::new_at(Self::default_dir()?))
    }

    #[cfg(windows)]
    pub fn default_dir() -> Result<PathBuf> {
        let appdata = std::env::var("APPDATA").context("%APPDATA% is not set")?;
        Ok(PathBuf::from(appdata).join("FTPeach"))
    }

    /// Tauri's app data folder, computed the way Tauri does: the store is
    /// opened before the app exists.
    #[cfg(not(windows))]
    pub fn default_dir() -> Result<PathBuf> {
        let data =
            dirs::data_dir().context("the user's data folder is unknown ($HOME is not set)")?;
        Ok(data.join("com.smooveemaan.ftpeach"))
    }

    pub fn new_at(dir: PathBuf) -> Self {
        Self {
            dir,
            vault_updates: Arc::default(),
            storage_issues: Arc::default(),
            write_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.dir.join("logs")
    }

    pub async fn has_plaintext_secret(&self) -> bool {
        self.sites_have_plaintext_secret().await
            || Self::secret_is_plaintext(&self.get_settings().await, "proxyPasswordPlain")
    }
}

#[cfg(test)]
mod tests;
