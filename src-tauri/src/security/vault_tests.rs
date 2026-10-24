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
        .open(vault.data_path())
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

/// A setup that could not write vault.json takes its snapshot back, so the
/// next attempt is not refused as "already configured".
#[tokio::test]
async fn failed_setup_leaves_nothing_that_blocks_the_next_one() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-setup-{}", uuid::Uuid::new_v4()));
    let vault = Vault::new(dir.clone());
    let blocker = Vault::temporary_path(&vault.metadata_path());
    std::fs::create_dir_all(&blocker).unwrap();
    assert!(vault.setup("correct horse battery staple").await.is_err());
    assert!(!vault.data_path().exists());
    assert!(!vault.is_unlocked().await);
    std::fs::remove_dir(&blocker).unwrap();
    vault.setup("correct horse battery staple").await.unwrap();
    assert!(vault.is_configured());
    vault.lock().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// Either file alone is a damaged vault: starting over sets it aside as
/// `*.damaged`, replacing an older copy, and a new vault can then be set up.
#[tokio::test]
async fn a_damaged_vault_is_set_aside_and_a_new_one_can_be_made() {
    for lone in ["vault.dat", "vault.hold", "vault.json"] {
        let dir =
            std::env::temp_dir().join(format!("ftpeach-vault-damaged-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Vault::new(dir.clone());
        std::fs::write(dir.join(lone), b"older").unwrap();
        vault.reset().await.unwrap();
        std::fs::write(dir.join(lone), b"newer").unwrap();
        assert!(vault.status().await.damaged);
        assert!(!vault.is_configured());
        vault.reset().await.unwrap();
        assert!(!dir.join(lone).exists());
        assert_eq!(
            std::fs::read(dir.join(format!("{lone}.damaged"))).unwrap(),
            b"newer"
        );
        assert!(!vault.status().await.damaged);
        vault.setup("correct horse battery staple").await.unwrap();
        assert!(vault.is_configured());
        vault.lock().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
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
    let snapshot = tokio::fs::read(vault.data_path()).await.unwrap();
    tokio::fs::write(vault.data_path(), b"corrupt snapshot")
        .await
        .unwrap();
    assert!(vault.unlock("a different strong password").await.is_err());
    tokio::fs::write(vault.data_path(), snapshot).await.unwrap();
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
async fn hello_stands_in_for_the_password_and_a_lost_key_does_not_jam_the_switch() {
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-hello-{}", uuid::Uuid::new_v4()));
    let (vault, keys) = computer(&dir);
    vault.setup(PASSWORD).await.unwrap();
    vault.enable_system_unlock(0).await.unwrap();
    // Windows Hello in place of the master password: open, and locked.
    vault.verify_system(0).await.unwrap();
    vault.lock().await;
    vault.verify_system(0).await.unwrap();
    assert!(vault.is_unlocked().await, "a locked vault is opened by it");
    keys.lose_everything();

    assert!(vault.verify_system(0).await.is_err());
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

/// A vault FTPeach 0.5.1 wrote with Stronghold 2.1 (test KDF parameters),
/// copied to a fresh folder, and the computer whose Windows Hello it knows.
/// `hello-key-name.txt` names that computer's key.
fn vault_of_0_5() -> (PathBuf, Vault, Arc<ComputerKeys>) {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/security/testdata/vault-0.5.1");
    let dir = std::env::temp_dir().join(format!("ftpeach-vault-0.5-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["vault.hold", "vault.json"] {
        std::fs::copy(fixture.join(name), dir.join(name)).unwrap();
    }
    let (vault, keys) = computer(&dir);
    let credential = std::fs::read_to_string(fixture.join("hello-key-name.txt")).unwrap();
    keys.0.lock().unwrap().insert(credential.trim().to_owned());
    (dir, vault, keys)
}

/// What the 0.5.1 fixture holds: 80 incompressible kilobyte keys, which take
/// the snapshot past one 64 KiB age chunk, and a few short secrets.
async fn holds_what_0_5_saved(vault: &Vault) {
    for i in 0..80u32 {
        let mut expected = vec![0u8; 1000];
        let mut x = i.wrapping_mul(2654435761).wrapping_add(1);
        for byte in &mut expected {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *byte = x as u8;
        }
        let site = format!("site-{i}");
        let value = vault.get_secret(&site, "privateKey").await.unwrap();
        assert_eq!(value.as_deref(), Some(&expected), "{site}");
    }
    let secret = |site: &'static str| async move {
        vault
            .get_secret(site, "password")
            .await
            .unwrap()
            .unwrap()
            .to_vec()
    };
    assert_eq!(
        secret("site-1").await,
        "\u{43f}\u{430}\u{440}\u{43e}\u{43b}\u{44c}-secret-value".as_bytes()
    );
    assert_eq!(secret("site-2").await, [b'a'; 300]);
    assert_eq!(secret("site-3").await, b"");
    assert_eq!(
        vault
            .get_proxy_password()
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"proxy-secret"
    );
    assert!(
        vault
            .get_secret("site-1", "keyPassphrase")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_vault_of_0_5_moves_to_the_new_file_on_its_first_unlock() {
    let (dir, vault, _keys) = vault_of_0_5();
    let snapshot = std::fs::read(dir.join("vault.hold")).unwrap();
    assert!(vault.is_configured() && !vault.is_damaged());
    assert!(vault.status().await.system_unlock_enabled);
    assert!(vault.unlock("wrong password").await.is_err());
    assert!(
        !vault.data_path().exists(),
        "a refused password moves nothing"
    );

    vault.unlock(PASSWORD).await.unwrap();
    holds_what_0_5_saved(&vault).await;
    assert!(vault.data_path().is_file());
    assert!(!dir.join("vault.hold").exists());
    assert_eq!(
        std::fs::read(dir.join("vault.hold.backup")).unwrap(),
        snapshot
    );
    assert!(vault.is_configured() && !vault.is_damaged());

    // From the new file now, by password and by Windows Hello alike.
    vault.lock().await;
    vault.unlock(PASSWORD).await.unwrap();
    holds_what_0_5_saved(&vault).await;
    vault.lock().await;
    vault.unlock_system(0).await.unwrap();
    holds_what_0_5_saved(&vault).await;

    // Starting over removes the backup with the rest.
    vault.reset().await.unwrap();
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn windows_hello_alone_moves_a_vault_of_0_5() {
    let (dir, vault, _keys) = vault_of_0_5();
    vault.unlock_system(0).await.unwrap();
    holds_what_0_5_saved(&vault).await;
    assert!(vault.data_path().is_file());
    assert!(dir.join("vault.hold.backup").is_file());
    vault.lock().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A move cut short after `vault.dat` was written: the new file is the
/// vault, and the snapshot left beside it is set aside at the next unlock.
#[tokio::test]
async fn a_move_cut_short_keeps_the_new_file_and_finishes() {
    let (dir, vault, _keys) = vault_of_0_5();
    let snapshot = std::fs::read(dir.join("vault.hold")).unwrap();
    vault.unlock(PASSWORD).await.unwrap();
    vault
        .apply_secret_updates(&[SecretUpdate::Set {
            site_id: "site-1",
            field: "password",
            value: b"changed after the move",
        }])
        .await
        .unwrap();
    vault.lock().await;
    std::fs::write(dir.join("vault.hold"), &snapshot).unwrap();
    std::fs::remove_file(dir.join("vault.hold.backup")).unwrap();

    vault.unlock(PASSWORD).await.unwrap();
    assert_eq!(
        vault
            .get_secret("site-1", "password")
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"changed after the move"
    );
    assert!(!dir.join("vault.hold").exists());
    assert!(dir.join("vault.hold.backup").is_file());
    vault.lock().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// 0.6 moved the vault, 0.5 came back and set one up anew, then 0.6 again:
/// the old vault.dat does not open with the new key, the new snapshot does.
#[tokio::test]
async fn a_vault_set_up_again_by_0_5_replaces_a_stale_new_file() {
    let (dir, vault, _keys) = vault_of_0_5();
    let mut stale = Secrets::new();
    stale.insert(
        b"site:site-1:password".to_vec(),
        zeroize::Zeroizing::new(b"stale".to_vec()),
    );
    std::fs::write(
        vault.data_path(),
        crate::security::vault_file::seal(&stale, &[7; 32]).unwrap(),
    )
    .unwrap();

    vault.unlock(PASSWORD).await.unwrap();
    holds_what_0_5_saved(&vault).await;
    assert!(!dir.join("vault.hold").exists());
    assert!(dir.join("vault.hold.backup").is_file());
    vault.lock().await;
    vault.unlock(PASSWORD).await.unwrap();
    holds_what_0_5_saved(&vault).await;
    vault.lock().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A damaged 0.5 snapshot does not open, is not a wrong password, and is
/// left exactly as it was, with nothing written beside it.
#[tokio::test]
async fn a_damaged_vault_of_0_5_fails_closed_and_stays_as_it_was() {
    let (dir, vault, _keys) = vault_of_0_5();
    let mut snapshot = std::fs::read(dir.join("vault.hold")).unwrap();
    let middle = snapshot.len() / 2;
    snapshot[middle] ^= 1;
    std::fs::write(dir.join("vault.hold"), &snapshot).unwrap();

    let error = vault.unlock(PASSWORD).await.unwrap_err();
    assert!(!is_refused(&error));
    assert!(vault.unlock_system(0).await.is_err());
    assert!(!vault.is_unlocked().await);
    assert!(!vault.data_path().exists());
    assert!(!dir.join("vault.hold.backup").exists());
    assert_eq!(std::fs::read(dir.join("vault.hold")).unwrap(), snapshot);
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
