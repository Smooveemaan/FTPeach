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
