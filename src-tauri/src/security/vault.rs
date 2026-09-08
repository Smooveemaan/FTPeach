use anyhow::{Context, Result, bail};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use iota_stronghold::{KeyProvider, SnapshotPath, Stronghold};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

const CLIENT: &[u8] = b"ftpeach-vault-v1";
const CHECK_KEY: &[u8] = b"vault-format";
const CHECK_VALUE: &[u8] = b"ftpeach-v1";
#[cfg(not(test))]
const KDF_MEMORY_KIB: u32 = 64 * 1024;
#[cfg(test)]
const KDF_MEMORY_KIB: u32 = 1024;
#[cfg(not(test))]
const KDF_ITERATIONS: u32 = 3;
#[cfg(test)]
const KDF_ITERATIONS: u32 = 1;
const KDF_PARALLELISM: u32 = 1;
const MIN_MASTER_PASSWORD_CHARS: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub configured: bool,
    pub locked: bool,
    pub system_unlock_available: bool,
    pub system_unlock_enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultMetadata {
    version: u8,
    kdf: KdfMetadata,
    wrapped_key: String,
    nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_unlock: Option<SystemUnlockMetadata>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemUnlockMetadata {
    #[serde(default)]
    scheme: String,
    credential: String,
    wrapped_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfMetadata {
    algorithm: String,
    version: u8,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

struct UnlockedVault {
    stronghold: Stronghold,
    data_key: Zeroizing<Vec<u8>>,
}

#[derive(Clone)]
pub struct Vault {
    dir: PathBuf,
    state: Arc<Mutex<Option<UnlockedVault>>>,
}

pub enum SecretUpdate<'a> {
    Set {
        site_id: &'a str,
        field: &'a str,
        value: &'a [u8],
    },
    Delete {
        site_id: &'a str,
        field: &'a str,
    },
}

impl Vault {
    fn validate_new_password(password: &str) -> Result<()> {
        if password.chars().count() < MIN_MASTER_PASSWORD_CHARS {
            bail!("master password must contain at least {MIN_MASTER_PASSWORD_CHARS} characters");
        }
        Ok(())
    }

    pub fn new(dir: PathBuf) -> Self {
        iota_stronghold::engine::snapshot::try_set_encrypt_work_factor(0)
            .expect("Stronghold must accept work factor 0 for a random snapshot key");
        Self {
            dir,
            state: Arc::new(Mutex::new(None)),
        }
    }

    fn snapshot_path(&self) -> PathBuf {
        self.dir.join("vault.hold")
    }
    fn metadata_path(&self) -> PathBuf {
        self.dir.join("vault.json")
    }

    fn secret_key(site_id: &str, field: &str) -> Vec<u8> {
        format!("site:{site_id}:{field}").into_bytes()
    }

    pub fn is_configured(&self) -> bool {
        self.snapshot_path().is_file() && self.metadata_path().is_file()
    }

    pub async fn is_unlocked(&self) -> bool {
        self.state.lock().await.is_some()
    }

    pub async fn status(&self) -> VaultStatus {
        VaultStatus {
            configured: self.is_configured(),
            locked: self.state.lock().await.is_none(),
            // Platform credentials are deliberately not claimed until a real
            // user-presence implementation is registered.
            system_unlock_available: crate::security::system_unlock::available(),
            system_unlock_enabled: self
                .read_metadata()
                .await
                .ok()
                .and_then(|m| m.system_unlock)
                .is_some_and(|system| system.scheme == "windows-hello-v1"),
        }
    }

    fn argon2(meta: &KdfMetadata) -> Result<Argon2<'static>> {
        if meta.algorithm != "argon2id" || meta.version != 1 {
            bail!("unsupported vault KDF");
        }
        if meta.memory_kib > 64 * 1024 || meta.iterations > 3 || meta.parallelism != 1 {
            bail!("vault KDF parameters exceed the supported version 1 budget");
        }
        let params = Params::new(meta.memory_kib, meta.iterations, meta.parallelism, Some(32))
            .map_err(|error| anyhow::anyhow!("invalid vault KDF parameters: {error}"))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }

    async fn derive_wrapping_key(password: &str, meta: &KdfMetadata) -> Result<Zeroizing<Vec<u8>>> {
        Self::argon2(meta)?;
        let password = Zeroizing::new(password.to_owned());
        let meta = meta.clone();
        super::kdf_executor::run(move || Self::derive_wrapping_key_blocking(&password, &meta)).await
    }

    fn derive_wrapping_key_blocking(
        password: &str,
        meta: &KdfMetadata,
    ) -> Result<Zeroizing<Vec<u8>>> {
        let salt = BASE64.decode(&meta.salt).context("invalid vault salt")?;
        let mut key = Zeroizing::new(vec![0u8; 32]);
        Self::argon2(meta)?
            .hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|error| anyhow::anyhow!("deriving vault key: {error}"))?;
        Ok(key)
    }

    async fn unwrap_data_key(
        password: &str,
        metadata: &VaultMetadata,
    ) -> Result<Zeroizing<Vec<u8>>> {
        let wrapping_key = Self::derive_wrapping_key(password, &metadata.kdf).await?;
        let nonce = BASE64
            .decode(&metadata.nonce)
            .context("invalid vault nonce")?;
        let wrapped = BASE64
            .decode(&metadata.wrapped_key)
            .context("invalid wrapped vault key")?;
        if nonce.len() != 24 {
            bail!("invalid vault nonce");
        }
        let nonce = XNonce::try_from(nonce.as_slice())
            .map_err(|_| anyhow::anyhow!("invalid vault nonce"))?;
        let cipher = XChaCha20Poly1305::new_from_slice(&wrapping_key)
            .map_err(|_| anyhow::anyhow!("invalid wrapping key"))?;
        let plain = cipher
            .decrypt(&nonce, wrapped.as_ref())
            .map_err(|_| anyhow::anyhow!("Incorrect master password"))?;
        if plain.len() != 32 {
            bail!("invalid vault key");
        }
        Ok(Zeroizing::new(plain))
    }

    async fn make_metadata(password: &str, data_key: &[u8]) -> Result<VaultMetadata> {
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut salt).context("generating KDF salt")?;
        getrandom::fill(&mut nonce).context("generating wrapping nonce")?;
        let kdf = KdfMetadata {
            algorithm: "argon2id".into(),
            version: 1,
            memory_kib: KDF_MEMORY_KIB,
            iterations: KDF_ITERATIONS,
            parallelism: KDF_PARALLELISM,
            salt: BASE64.encode(salt),
        };
        let wrapping_key = Self::derive_wrapping_key(password, &kdf).await?;
        let cipher = XChaCha20Poly1305::new_from_slice(&wrapping_key)
            .map_err(|_| anyhow::anyhow!("invalid wrapping key"))?;
        let nonce = XNonce::try_from(nonce.as_slice())
            .map_err(|_| anyhow::anyhow!("invalid wrapping nonce"))?;
        let wrapped = cipher
            .encrypt(&nonce, data_key)
            .map_err(|_| anyhow::anyhow!("wrapping vault key"))?;
        Ok(VaultMetadata {
            version: 1,
            kdf,
            wrapped_key: BASE64.encode(wrapped),
            nonce: BASE64.encode(nonce.as_slice()),
            system_unlock: None,
        })
    }

    async fn read_metadata(&self) -> Result<VaultMetadata> {
        use tokio::io::AsyncReadExt;
        const MAX_METADATA_BYTES: u64 = 64 * 1024;
        let file = tokio::fs::File::open(self.metadata_path())
            .await
            .context("reading vault metadata")?;
        let mut raw = Vec::new();
        file.take(MAX_METADATA_BYTES + 1)
            .read_to_end(&mut raw)
            .await?;
        anyhow::ensure!(
            raw.len() as u64 <= MAX_METADATA_BYTES,
            "vault metadata exceeds size budget"
        );
        let metadata: VaultMetadata =
            serde_json::from_slice(&raw).context("invalid vault metadata")?;
        anyhow::ensure!(metadata.version == 1, "unsupported vault metadata version");
        Self::argon2(&metadata.kdf)?;
        Ok(metadata)
    }

    async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        tokio::fs::write(&tmp, bytes)
            .await
            .context("writing vault temporary file")?;
        Self::replace_file(&tmp, path).context("committing vault file")?;
        Ok(())
    }

    #[cfg(windows)]
    fn replace_file(source: &Path, destination: &Path) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        use windows::core::PCWSTR;

        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .context("replacing file")?;
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn replace_file(source: &Path, destination: &Path) -> Result<()> {
        std::fs::rename(source, destination).context("replacing file")
    }

    fn commit(&self, unlocked: &UnlockedVault) -> Result<()> {
        unlocked
            .stronghold
            .write_client(CLIENT)
            .context("staging vault")?;
        let key = KeyProvider::try_from(Zeroizing::new(unlocked.data_key.to_vec()))
            .context("vault key")?;
        let snapshot_path = self.snapshot_path();
        let temporary_path = snapshot_path.with_extension(format!("{}.tmp", std::process::id()));
        let result = unlocked
            .stronghold
            .commit_with_keyprovider(&SnapshotPath::from_path(&temporary_path), &key)
            .context("saving vault temporary snapshot")
            .and_then(|_| Self::replace_file(&temporary_path, &snapshot_path));
        if result.is_err() {
            let _ = std::fs::remove_file(temporary_path);
        }
        result
    }

    pub async fn get_secret(
        &self,
        site_id: &str,
        field: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let state = self.state.lock().await;
        let unlocked = state.as_ref().context("vault is locked")?;
        let client = unlocked
            .stronghold
            .get_client(CLIENT)
            .context("opening vault client")?;
        Ok(client
            .store()
            .get(&Self::secret_key(site_id, field))
            .context("reading vault secret")?
            .map(Zeroizing::new))
    }

    pub async fn apply_secret_updates(&self, updates: &[SecretUpdate<'_>]) -> Result<()> {
        let state = self.state.lock().await;
        let unlocked = state.as_ref().context("vault is locked")?;
        let client = unlocked
            .stronghold
            .get_client(CLIENT)
            .context("opening vault client")?;
        let store = client.store();
        let mut previous = std::collections::HashMap::new();
        for update in updates {
            let (SecretUpdate::Set { site_id, field, .. }
            | SecretUpdate::Delete { site_id, field }) = update;
            let key = Self::secret_key(site_id, field);
            if let std::collections::hash_map::Entry::Vacant(entry) = previous.entry(key) {
                let value = store.get(entry.key())?.map(Zeroizing::new);
                entry.insert(value);
            }
        }
        let result = (|| -> Result<()> {
            for update in updates {
                match update {
                    SecretUpdate::Set {
                        site_id,
                        field,
                        value,
                    } => {
                        store
                            .insert(Self::secret_key(site_id, field), value.to_vec(), None)
                            .context("writing vault secret")?;
                    }
                    SecretUpdate::Delete { site_id, field } => {
                        store
                            .delete(&Self::secret_key(site_id, field))
                            .context("deleting vault secret")?;
                    }
                }
            }
            self.commit(unlocked)
        })();
        if let Err(error) = result {
            // The old on-disk snapshot was preserved by atomic replacement.
            // Restore memory as well so a later commit cannot persist failed updates.
            for (key, value) in previous {
                match value {
                    Some(value) => {
                        store.insert(key, value.to_vec(), None).with_context(|| {
                            format!("Vault update failed ({error:#}); in-memory rollback failed")
                        })?;
                    }
                    None => {
                        store.delete(&key).with_context(|| {
                            format!("Vault update failed ({error:#}); in-memory rollback failed")
                        })?;
                    }
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn setup(&self, password: &str) -> Result<()> {
        Self::validate_new_password(password)?;
        if self.metadata_path().exists() || self.snapshot_path().exists() {
            bail!("vault is already configured");
        }
        tokio::fs::create_dir_all(&self.dir)
            .await
            .context("creating vault directory")?;
        let mut raw_key = vec![0u8; 32];
        getrandom::fill(&mut raw_key).context("generating vault key")?;
        let data_key = Zeroizing::new(raw_key);
        let metadata = Self::make_metadata(password, &data_key).await?;
        let stronghold = Stronghold::default();
        let client = stronghold
            .create_client(CLIENT)
            .context("creating Stronghold client")?;
        client
            .store()
            .insert(CHECK_KEY.to_vec(), CHECK_VALUE.to_vec(), None)
            .context("initializing vault")?;
        stronghold.write_client(CLIENT).context("staging vault")?;
        let temporary_snapshot = self
            .snapshot_path()
            .with_extension(format!("{}.tmp", std::process::id()));
        stronghold
            .commit_with_keyprovider(
                &SnapshotPath::from_path(&temporary_snapshot),
                &KeyProvider::try_from(Zeroizing::new(data_key.to_vec())).context("vault key")?,
            )
            .context("saving vault")?;
        Self::replace_file(&temporary_snapshot, &self.snapshot_path())?;
        Self::atomic_write(
            &self.metadata_path(),
            &serde_json::to_vec_pretty(&metadata)?,
        )
        .await?;
        *self.state.lock().await = Some(UnlockedVault {
            stronghold,
            data_key,
        });
        Ok(())
    }

    pub async fn unlock(&self, password: &str) -> Result<()> {
        let started = std::time::Instant::now();
        let metadata = self.read_metadata().await?;
        let metadata_loaded = started.elapsed();
        let data_key = Self::unwrap_data_key(password, &metadata).await?;
        let key_derived = started.elapsed();
        let stronghold = Stronghold::default();
        let client = stronghold
            .load_client_from_snapshot(
                CLIENT,
                &KeyProvider::try_from(Zeroizing::new(data_key.to_vec())).context("vault key")?,
                &SnapshotPath::from_path(self.snapshot_path()),
            )
            .map_err(|_| anyhow::anyhow!("Incorrect master password or damaged vault"))?;
        let snapshot_loaded = started.elapsed();
        if client.store().get(CHECK_KEY).ok().flatten().as_deref() != Some(CHECK_VALUE) {
            bail!("damaged vault");
        }
        let unlocked = UnlockedVault {
            stronghold,
            data_key,
        };
        self.commit(&unlocked)?;
        *self.state.lock().await = Some(unlocked);
        if cfg!(debug_assertions) {
            eprintln!(
                "FTPeach vault unlock timings: metadata={}ms, argon2={}ms, stronghold={}ms, total={}ms",
                metadata_loaded.as_millis(),
                key_derived.saturating_sub(metadata_loaded).as_millis(),
                snapshot_loaded.saturating_sub(key_derived).as_millis(),
                started.elapsed().as_millis(),
            );
        }
        Ok(())
    }

    /// Verifies the master password without changing the unlocked state or
    /// returning key material to the renderer.
    pub async fn verify_password(&self, password: &str) -> Result<()> {
        let metadata = self.read_metadata().await?;
        let _ = Self::unwrap_data_key(password, &metadata).await?;
        Ok(())
    }

    async fn unlock_with_data_key(&self, data_key: Zeroizing<Vec<u8>>) -> Result<()> {
        if data_key.len() != 32 {
            bail!("invalid system vault key");
        }
        let stronghold = Stronghold::default();
        let client = stronghold
            .load_client_from_snapshot(
                CLIENT,
                &KeyProvider::try_from(Zeroizing::new(data_key.to_vec())).context("vault key")?,
                &SnapshotPath::from_path(self.snapshot_path()),
            )
            .map_err(|_| {
                anyhow::anyhow!(
                    "system credential changed or vault is damaged; use the master password"
                )
            })?;
        if client.store().get(CHECK_KEY).ok().flatten().as_deref() != Some(CHECK_VALUE) {
            bail!("damaged vault");
        }
        *self.state.lock().await = Some(UnlockedVault {
            stronghold,
            data_key,
        });
        Ok(())
    }

    pub async fn enable_system_unlock(&self, hwnd: isize) -> Result<()> {
        let state = self.state.lock().await;
        let unlocked = state.as_ref().context("vault is locked")?;
        let mut metadata = self.read_metadata().await?;
        if let Some(existing) = metadata.system_unlock.take() {
            if existing.scheme == "windows-hello-v1" {
                return Ok(());
            }
            let _ = crate::security::system_unlock::revoke(&existing.credential);
        }
        let credential = format!("FTPeach-vault-{}", uuid::Uuid::new_v4());
        let wrapped =
            crate::security::system_unlock::register(&credential, &unlocked.data_key, hwnd)?;
        metadata.system_unlock = Some(SystemUnlockMetadata {
            scheme: "windows-hello-v1".into(),
            credential,
            wrapped_key: BASE64.encode(wrapped),
        });
        drop(state);
        if let Err(error) = Self::atomic_write(
            &self.metadata_path(),
            &serde_json::to_vec_pretty(&metadata)?,
        )
        .await
        {
            if let Some(system) = metadata.system_unlock {
                let _ = crate::security::system_unlock::revoke(&system.credential);
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn unlock_system(&self, hwnd: isize) -> Result<()> {
        let metadata = self.read_metadata().await?;
        let system = metadata
            .system_unlock
            .context("system unlock is not enabled")?;
        if system.scheme != "windows-hello-v1" {
            bail!("system credential must be registered again; use the master password");
        }
        let wrapped = BASE64
            .decode(system.wrapped_key)
            .context("invalid system credential")?;
        let key = Zeroizing::new(crate::security::system_unlock::unwrap(
            &system.credential,
            &wrapped,
            hwnd,
        )?);
        self.unlock_with_data_key(key).await
    }

    pub async fn disable_system_unlock(&self) -> Result<()> {
        let mut metadata = self.read_metadata().await?;
        let Some(system) = metadata.system_unlock.take() else {
            return Ok(());
        };
        crate::security::system_unlock::revoke(&system.credential)?;
        Self::atomic_write(
            &self.metadata_path(),
            &serde_json::to_vec_pretty(&metadata)?,
        )
        .await
    }

    pub async fn lock(&self) {
        if let Some(mut unlocked) = self.state.lock().await.take() {
            let _ = unlocked.stronghold.clear();
            unlocked.data_key.zeroize();
        }
    }

    pub async fn change_password(&self, old_password: &str, new_password: &str) -> Result<()> {
        Self::validate_new_password(new_password)?;
        let old = self.read_metadata().await?;
        let data_key = Self::unwrap_data_key(old_password, &old).await?;
        let mut new = Self::make_metadata(new_password, &data_key).await?;
        new.system_unlock = old.system_unlock;
        Self::atomic_write(&self.metadata_path(), &serde_json::to_vec_pretty(&new)?).await
    }

    pub async fn reset(&self) -> Result<()> {
        self.lock().await;
        self.remove_files().await
    }

    pub async fn remove_unlocked(&self) -> Result<()> {
        if !self.is_unlocked().await {
            bail!("vault is locked");
        }
        self.lock().await;
        self.remove_files().await
    }

    async fn remove_files(&self) -> Result<()> {
        if let Ok(metadata) = self.read_metadata().await
            && let Some(system) = metadata.system_unlock
        {
            let _ = crate::security::system_unlock::revoke(&system.credential);
        }
        for path in [self.snapshot_path(), self.metadata_path()] {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).context("removing vault"),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
