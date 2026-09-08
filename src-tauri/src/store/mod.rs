mod known_hosts;
mod secret_fields;
mod settings;
mod settings_schema;
pub(crate) use settings_schema::validate_settings;
mod sites;
mod storage;
mod tabs;

pub(crate) use sites::validate_site_input;

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
    storage_issues: Arc<std::sync::Mutex<HashMap<PathBuf, (String, bool)>>>,
    write_locks: Arc<std::sync::Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>>,
}

impl Store {
    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    pub fn new() -> Result<Self> {
        let appdata = std::env::var("APPDATA").context("%APPDATA% is not set")?;
        let dir = PathBuf::from(appdata).join("FTPeach");
        Ok(Self {
            dir,
            vault_updates: Arc::default(),
            storage_issues: Arc::default(),
            write_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
        })
    }

    #[cfg(any(test, feature = "test-utils"))]
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
