use super::*;

#[cfg(windows)]
#[tokio::test]
async fn failed_snapshot_commit_rolls_back_in_memory_secrets() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = std::env::temp_dir().join(format!("ftpeach-vault-commit-{}", uuid::Uuid::new_v4()));
    let vault = Vault::new(root.clone());
    vault.setup("correct horse battery staple").await.unwrap();
    vault
        .apply_secret_updates(&[SecretUpdate::Set {
            site_id: "site",
            field: "password",
            value: b"original",
        }])
        .await
        .unwrap();
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(vault.snapshot_path())
        .unwrap();
    assert!(
        vault
            .apply_secret_updates(&[SecretUpdate::Delete {
                site_id: "site",
                field: "password"
            }])
            .await
            .is_err()
    );
    assert_eq!(
        vault
            .get_secret("site", "password")
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"original"
    );
    drop(deny_replace);
    vault.lock().await;
    vault.unlock("correct horse battery staple").await.unwrap();
    assert_eq!(
        vault
            .get_secret("site", "password")
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"original"
    );
    vault.lock().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn rejects_oversized_metadata_and_kdf_before_computation() {
    let dir = std::env::temp_dir().join(format!("ftpeach-kdf-budget-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let vault = Vault::new(dir.clone());
    std::fs::write(vault.metadata_path(), vec![b' '; 65 * 1024]).unwrap();
    assert!(
        vault
            .read_metadata()
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("size budget")
    );
    for (memory_kib, iterations, parallelism) in
        [(u32::MAX, 3, 1), (65536, u32::MAX, 1), (65536, 3, 128)]
    {
        let meta = KdfMetadata {
            algorithm: "argon2id".into(),
            version: 1,
            memory_kib,
            iterations,
            parallelism,
            salt: BASE64.encode([0u8; 16]),
        };
        assert!(Vault::derive_wrapping_key("password", &meta).await.is_err());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn setup_lock_unlock_and_password_change_preserve_secrets() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-test-{}", uuid::Uuid::new_v4()));
    let vault = Vault::new(dir.clone());
    vault.setup("correct horse battery staple").await.unwrap();
    vault
        .apply_secret_updates(&[SecretUpdate::Set {
            site_id: "site-1",
            field: "password",
            value: b"secret-value",
        }])
        .await
        .unwrap();

    vault.lock().await;
    assert!(vault.get_secret("site-1", "password").await.is_err());
    assert!(vault.unlock("wrong password").await.is_err());
    vault.unlock("correct horse battery staple").await.unwrap();
    assert_eq!(
        vault
            .get_secret("site-1", "password")
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"secret-value"
    );

    vault
        .apply_secret_updates(&[SecretUpdate::Delete {
            site_id: "site-1",
            field: "password",
        }])
        .await
        .unwrap();
    assert!(
        vault
            .get_secret("site-1", "password")
            .await
            .unwrap()
            .is_none()
    );
    vault
        .apply_secret_updates(&[SecretUpdate::Set {
            site_id: "site-1",
            field: "password",
            value: b"secret-value",
        }])
        .await
        .unwrap();

    vault
        .change_password(
            "correct horse battery staple",
            "a different strong password",
        )
        .await
        .unwrap();
    vault.lock().await;
    assert!(vault.unlock("correct horse battery staple").await.is_err());
    vault.unlock("a different strong password").await.unwrap();
    assert_eq!(
        vault
            .get_secret("site-1", "password")
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"secret-value"
    );

    vault.lock().await;
    let snapshot = tokio::fs::read(vault.snapshot_path()).await.unwrap();
    tokio::fs::write(vault.snapshot_path(), b"corrupt snapshot")
        .await
        .unwrap();
    assert!(vault.unlock("a different strong password").await.is_err());
    tokio::fs::write(vault.snapshot_path(), snapshot)
        .await
        .unwrap();
    vault.unlock("a different strong password").await.unwrap();

    vault.reset().await.unwrap();
    assert!(!vault.is_configured());
    assert!(vault.status().await.locked);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

/// One computer's key store. A key wraps nothing here; what matters is that
/// only the store that registered a name can use it, as with a platform key.
#[derive(Default)]
struct ComputerKeys(std::sync::Mutex<std::collections::HashSet<String>>);

impl ComputerKeys {
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
    /// What a TPM reset or a reinstalled Windows leaves behind.
    fn lose_everything(&self) {
        self.0.lock().unwrap().clear();
    }
}

impl Keys for ComputerKeys {
    fn exists(&self, name: &str) -> bool {
        self.0.lock().unwrap().contains(name)
    }
    fn register(&self, name: &str, plaintext: &[u8], _: isize) -> Result<Vec<u8>> {
        self.0.lock().unwrap().insert(name.to_owned());
        Ok(plaintext.to_vec())
    }
    fn unwrap(&self, name: &str, ciphertext: &[u8], _: isize) -> Result<Vec<u8>> {
        anyhow::ensure!(self.exists(name), "no such key on this computer");
        Ok(ciphertext.to_vec())
    }
    fn revoke(&self, name: &str) -> Result<()> {
        anyhow::ensure!(
            self.0.lock().unwrap().remove(name),
            "no such key on this computer"
        );
        Ok(())
    }
}

const PASSWORD: &str = "correct horse battery staple";

/// The same vault folder as a computer with its own key store sees it.
fn computer(dir: &Path) -> (Vault, Arc<ComputerKeys>) {
    let keys = Arc::new(ComputerKeys::default());
    (Vault::with_keys(dir.to_path_buf(), keys.clone()), keys)
}

async fn hello_enabled(vault: &Vault) -> bool {
    vault.status().await.system_unlock_enabled
}

#[tokio::test]
async fn windows_hello_is_switched_on_and_off_per_computer() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-hello-{}", uuid::Uuid::new_v4()));
    let (home, home_keys) = computer(&dir);
    let (away, away_keys) = computer(&dir);
    home.setup(PASSWORD).await.unwrap();
    home.enable_system_unlock(0).await.unwrap();
    // Asking twice registers nothing more.
    home.enable_system_unlock(0).await.unwrap();
    assert_eq!(home_keys.count(), 1);
    assert!(hello_enabled(&home).await);
    home.lock().await;

    // Carried to another computer, the vault is not enabled there: only the
    // master password opens it, and the switch can be turned on.
    assert!(!hello_enabled(&away).await);
    assert!(away.unlock_system(0).await.is_err());
    away.disable_system_unlock().await.unwrap();
    away.unlock(PASSWORD).await.unwrap();
    away.enable_system_unlock(0).await.unwrap();
    assert!(hello_enabled(&away).await);
    away.lock().await;
    away.unlock_system(0).await.unwrap();
    away.lock().await;

    // Back on the first computer its own credential still works.
    home.unlock_system(0).await.unwrap();
    home.lock().await;

    // Switching it off on one computer leaves the other as it was.
    away.disable_system_unlock().await.unwrap();
    assert_eq!(away_keys.count(), 0);
    assert!(!hello_enabled(&away).await);
    assert!(away.unlock_system(0).await.is_err());
    assert!(hello_enabled(&home).await);
    home.unlock_system(0).await.unwrap();

    // A password change keeps the credentials of every computer.
    home.change_password(PASSWORD, "a different strong password")
        .await
        .unwrap();
    home.lock().await;
    home.unlock_system(0).await.unwrap();
    home.reset().await.unwrap();
    assert_eq!(home_keys.count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_credential_whose_key_is_gone_does_not_jam_the_switch() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-hello-{}", uuid::Uuid::new_v4()));
    let (vault, keys) = computer(&dir);
    vault.setup(PASSWORD).await.unwrap();
    vault.enable_system_unlock(0).await.unwrap();
    keys.lose_everything();

    assert!(!hello_enabled(&vault).await);
    vault.disable_system_unlock().await.unwrap();
    vault.enable_system_unlock(0).await.unwrap();
    assert!(hello_enabled(&vault).await);
    vault.lock().await;
    vault.unlock_system(0).await.unwrap();
    vault.reset().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_single_credential_of_earlier_versions_is_still_read() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-hello-{}", uuid::Uuid::new_v4()));
    let (vault, _keys) = computer(&dir);
    vault.setup(PASSWORD).await.unwrap();
    vault.enable_system_unlock(0).await.unwrap();
    vault.lock().await;
    // The file as an earlier version wrote it.
    let mut file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(vault.metadata_path()).unwrap()).unwrap();
    let entry = file["systemUnlocks"][0].take();
    file.as_object_mut().unwrap().remove("systemUnlocks");
    file["systemUnlock"] = entry;
    std::fs::write(vault.metadata_path(), serde_json::to_vec(&file).unwrap()).unwrap();

    assert!(hello_enabled(&vault).await);
    vault.unlock_system(0).await.unwrap();
    // The next write stores it in the list.
    vault
        .change_password(PASSWORD, "a different strong password")
        .await
        .unwrap();
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(vault.metadata_path()).unwrap()).unwrap();
    assert!(file.get("systemUnlock").is_none());
    assert_eq!(file["systemUnlocks"].as_array().unwrap().len(), 1);
    vault.reset().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_list_of_computers_is_bounded_and_the_oldest_gives_way() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-hello-{}", uuid::Uuid::new_v4()));
    let (first, _first_keys) = computer(&dir);
    first.setup(PASSWORD).await.unwrap();
    first.enable_system_unlock(0).await.unwrap();
    first.lock().await;
    for _ in 0..MAX_SYSTEM_UNLOCKS {
        let (next, _next_keys) = computer(&dir);
        next.unlock(PASSWORD).await.unwrap();
        next.enable_system_unlock(0).await.unwrap();
        assert!(hello_enabled(&next).await);
        next.lock().await;
    }
    let metadata = first.read_metadata().await.unwrap();
    assert_eq!(metadata.system_unlocks.len(), MAX_SYSTEM_UNLOCKS);
    // The first computer falls back to the master password.
    assert!(!hello_enabled(&first).await);
    first.unlock(PASSWORD).await.unwrap();
    first.reset().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
