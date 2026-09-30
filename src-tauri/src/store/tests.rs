use super::storage::{decode_versioned_store, encode_versioned_store};
use super::*;
use crate::domain::SiteLayoutEntry;
use crate::security::vault::Vault;
use serde_json::{Value, json};

#[tokio::test]
async fn connection_limit_survives_site_storage_and_can_be_cleared() {
    let root =
        std::env::temp_dir().join(format!("ftpeach-connection-limit-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let mut input = json!({"id":"limited", "name":"FTP", "protocol":"ftp", "host":"example.test", "maxConnections":5}).as_object().unwrap().clone();
    store.save_site(input.clone()).await.unwrap();
    assert_eq!(store.list_sites().await.unwrap()[0]["maxConnections"], 5);
    assert_eq!(
        store.connection_config_for_site("limited").await.unwrap()["maxConnections"],
        5
    );
    input.remove("maxConnections");
    store.save_site(input.clone()).await.unwrap();
    assert_eq!(
        store.connection_config_for_site("limited").await.unwrap()["maxConnections"],
        5
    );
    for invalid in [json!(1), json!(129), json!(-1), json!(2.5), json!("bad")] {
        input.insert("maxConnections".into(), invalid);
        assert!(store.save_site(input.clone()).await.is_err());
    }
    input.insert("maxConnections".into(), json!(0));
    store.save_site(input).await.unwrap();
    assert_eq!(
        store.connection_config_for_site("limited").await.unwrap()["maxConnections"],
        0
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn file_name_encoding_survives_site_storage() {
    let root = std::env::temp_dir().join(format!("ftpeach-encoding-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let mut input = json!({"id":"legacy", "name":"FTP", "protocol":"ftp", "host":"example.test", "encoding":"windows-1251"}).as_object().unwrap().clone();
    store.save_site(input.clone()).await.unwrap();
    assert_eq!(
        store.list_sites().await.unwrap()[0]["encoding"],
        "windows-1251"
    );
    assert_eq!(
        store.connection_config_for_site("legacy").await.unwrap()["encoding"],
        "windows-1251"
    );
    for invalid in [json!("klingon"), json!("utf-16le"), json!(1251)] {
        input.insert("encoding".into(), invalid);
        assert!(store.save_site(input.clone()).await.is_err());
    }
    input.remove("encoding");
    store.save_site(input).await.unwrap();
    assert_eq!(store.list_sites().await.unwrap()[0]["encoding"], "");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn a_failed_downgrade_keeps_the_vault_and_copies_no_secret_out() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = std::env::temp_dir().join(format!("ftpeach-downgrade-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());
    vault.setup("correct horse battery staple").await.unwrap();
    store
        .set_settings_with_vault(
            proxy_patch(json!({"proxyPassword": "proxy-secret"})),
            &vault,
        )
        .await
        .unwrap();
    let site: JsonMap = serde_json::from_value(json!({"id":"site", "name":"Site", "protocol":"ftp", "host":"example.test", "password":"site-secret"})).unwrap();
    store
        .save_site_with_vault(site, None, &vault)
        .await
        .unwrap();
    let settings_before = std::fs::read_to_string(root.join("settings.json")).unwrap();
    let sites_before = std::fs::read(root.join("sites.json")).unwrap();

    // A locked vault is refused before anything is touched.
    vault.lock().await;
    assert!(store.downgrade_to_system_protection(&vault).await.is_err());
    assert!(vault.is_configured());
    vault.unlock("correct horse battery staple").await.unwrap();

    // The proxy password moves out first; sites.json then cannot be
    // replaced, so the proxy copy must be taken back and the vault kept.
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.join("sites.json"))
        .unwrap();
    assert!(store.downgrade_to_system_protection(&vault).await.is_err());
    drop(deny_replace);
    assert!(vault.is_configured());
    let settings_after = std::fs::read_to_string(root.join("settings.json")).unwrap();
    assert!(
        !settings_after.contains("proxyPasswordEnc"),
        "{settings_after}"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&settings_after).unwrap()["data"]["hasProxyPassword"],
        serde_json::from_str::<Value>(&settings_before).unwrap()["data"]["hasProxyPassword"]
    );
    assert_eq!(
        std::fs::read(root.join("sites.json")).unwrap(),
        sites_before
    );
    assert_eq!(
        vault
            .get_proxy_password()
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"proxy-secret"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn sites_commit_failure_restores_vault_secrets_for_save_and_delete() {
    use std::os::windows::fs::OpenOptionsExt;
    let root =
        std::env::temp_dir().join(format!("ftpeach-site-transaction-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());
    vault.setup("correct horse battery staple").await.unwrap();
    let mut site: JsonMap = serde_json::from_value(json!({"id":"site", "name":"Site", "protocol":"ftp", "host":"example.test", "password":"original"})).unwrap();
    store
        .save_site_with_vault(site.clone(), None, &vault)
        .await
        .unwrap();
    let original = std::fs::read(root.join("sites.json")).unwrap();
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.join("sites.json"))
        .unwrap();
    let unchanged = async || {
        assert_eq!(
            vault
                .get_secret("site", "password")
                .await
                .unwrap()
                .unwrap()
                .as_slice(),
            b"original"
        );
        assert_eq!(std::fs::read(root.join("sites.json")).unwrap(), original);
    };
    site.insert("password".into(), json!("replacement"));
    assert!(
        store
            .save_site_with_vault(site, None, &vault)
            .await
            .is_err()
    );
    unchanged().await;
    assert!(
        store
            .delete_site_with_vault("site".into(), &vault)
            .await
            .is_err()
    );
    unchanged().await;
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

#[cfg(windows)]
fn proxy_patch(extra: Value) -> JsonMap {
    let mut patch: JsonMap = serde_json::from_value(
        json!({"proxyEnabled": true, "proxyType": "socks5", "proxyHost": "proxy.test", "proxyPort": 1080}),
    )
    .unwrap();
    patch.extend(serde_json::from_value::<JsonMap>(extra).unwrap());
    patch
}

#[cfg(windows)]
async fn connect_proxy_password(store: &Store, vault: &Vault) -> Option<String> {
    store
        .connection_defaults(vault, 0, false)
        .await
        .unwrap()
        .proxy
        .and_then(|proxy| proxy.password)
        .map(|password| password.expose().to_owned())
}

#[tokio::test]
async fn a_connect_takes_host_key_policy_and_proxy_from_the_saved_settings() {
    let root = std::env::temp_dir().join(format!("ftpeach-defaults-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());
    // The timeout and FTP mode are the window's, as sent.
    let defaults = store.connection_defaults(&vault, 1234, true).await.unwrap();
    assert_eq!((defaults.timeout_ms, defaults.active_mode), (1234, true));
    assert!(defaults.strict_host_key_check);
    assert!(defaults.proxy.is_none());

    store
        .set_settings(serde_json::from_value(json!({"strictHostKeyCheck": false})).unwrap())
        .await
        .unwrap();
    store
        .set_settings(
            serde_json::from_value(json!({"proxyEnabled": true, "proxyType": "socks4", "proxyHost": " [::1] ", "proxyPort": 1080, "proxyUsername": ""})).unwrap(),
        )
        .await
        .unwrap();
    let defaults = store.connection_defaults(&vault, 0, false).await.unwrap();
    assert!(!defaults.strict_host_key_check);
    let proxy = defaults.proxy.unwrap();
    assert_eq!(proxy.authority(), "[::1]:1080");
    assert!(proxy.username.is_none() && proxy.password.is_none());

    // A switch an older version saved without an address, or with a port
    // out of range, connects directly.
    for (host, port) in [
        (json!(""), json!(1080)),
        (json!("proxy.test"), json!(0)),
        (json!("proxy.test"), json!(70000)),
    ] {
        std::fs::write(
            root.join("settings.json"),
            json!({"proxyEnabled": true, "proxyHost": host, "proxyPort": port}).to_string(),
        )
        .unwrap();
        assert!(
            store
                .connection_defaults(&vault, 0, false)
                .await
                .unwrap()
                .proxy
                .is_none()
        );
    }
    for host in ["proxy.test/path".to_owned(), "p".repeat(256)] {
        std::fs::write(
            root.join("settings.json"),
            json!({"proxyEnabled": true, "proxyHost": host, "proxyPort": 1080}).to_string(),
        )
        .unwrap();
        let refused = store
            .connection_defaults(&vault, 0, false)
            .await
            .unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&refused).code,
            crate::ipc::ErrorCode::InvalidInput
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn proxy_password_moves_with_enhanced_protection() {
    let root = std::env::temp_dir().join(format!("ftpeach-proxy-vault-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());
    let settings_raw = || std::fs::read_to_string(root.join("settings.json")).unwrap();

    // System protection keeps the password in settings.json with DPAPI.
    store
        .set_settings_with_vault(
            proxy_patch(json!({"proxyPassword": "first-secret"})),
            &vault,
        )
        .await
        .unwrap();
    assert!(settings_raw().contains("proxyPasswordEnc"));
    assert_eq!(
        connect_proxy_password(&store, &vault).await.as_deref(),
        Some("first-secret")
    );

    // Turning on enhanced protection moves it into the vault.
    vault.setup("correct horse battery staple").await.unwrap();
    store.migrate_secrets_to_vault(&vault).await.unwrap();
    assert!(!settings_raw().contains("proxyPasswordEnc"));
    assert!(settings_raw().contains("hasProxyPassword"));
    assert_eq!(
        vault
            .get_proxy_password()
            .await
            .unwrap()
            .unwrap()
            .as_slice(),
        b"first-secret"
    );
    assert_eq!(
        connect_proxy_password(&store, &vault).await.as_deref(),
        Some("first-secret")
    );

    // A locked vault blocks connecting and changing the password, not other settings.
    vault.lock().await;
    let locked = store
        .connection_defaults(&vault, 0, false)
        .await
        .unwrap_err();
    assert!(format!("{locked:#}").contains("vault is locked"));
    assert!(store.reveal_proxy_password(&vault).await.is_err());
    let locked = store
        .set_settings_with_vault(
            proxy_patch(json!({"proxyPassword": "second-secret"})),
            &vault,
        )
        .await
        .unwrap_err();
    assert!(format!("{locked:#}").contains("vault is locked"));
    store
        .set_settings_with_vault(proxy_patch(json!({"proxyPort": 1081})), &vault)
        .await
        .unwrap();
    assert!(settings_raw().contains("hasProxyPassword"));

    vault.unlock("correct horse battery staple").await.unwrap();
    store
        .set_settings_with_vault(
            proxy_patch(json!({"proxyPassword": "second-secret"})),
            &vault,
        )
        .await
        .unwrap();
    assert!(!settings_raw().contains("second-secret"));
    assert_eq!(
        store
            .reveal_proxy_password(&vault)
            .await
            .unwrap()
            .as_deref(),
        Some("second-secret")
    );

    // Switching back to system protection returns it to DPAPI.
    store.downgrade_to_system_protection(&vault).await.unwrap();
    assert!(!vault.is_configured());
    assert!(settings_raw().contains("proxyPasswordEnc"));
    assert!(!settings_raw().contains("hasProxyPassword"));
    assert_eq!(
        connect_proxy_password(&store, &vault).await.as_deref(),
        Some("second-secret")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn vault_reset_and_removal_forget_the_proxy_password() {
    let root = std::env::temp_dir().join(format!("ftpeach-proxy-reset-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());
    vault.setup("correct horse battery staple").await.unwrap();
    store
        .set_settings_with_vault(
            proxy_patch(json!({"proxyPassword": "reset-secret"})),
            &vault,
        )
        .await
        .unwrap();
    store
        .set_settings_with_vault(proxy_patch(json!({"removeProxyPassword": true})), &vault)
        .await
        .unwrap();
    assert!(vault.get_proxy_password().await.unwrap().is_none());
    assert_eq!(connect_proxy_password(&store, &vault).await, None);

    store
        .set_settings_with_vault(
            proxy_patch(json!({"proxyPassword": "reset-secret"})),
            &vault,
        )
        .await
        .unwrap();
    vault.reset().await.unwrap();
    store.clear_vault_secret_flags().await.unwrap();
    let raw = std::fs::read_to_string(root.join("settings.json")).unwrap();
    assert!(!raw.contains("hasProxyPassword"));
    assert!(!raw.contains("proxyPasswordEnc"));
    assert_eq!(connect_proxy_password(&store, &vault).await, None);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_removed_vault_migration_marker_does_not_come_back_from_its_backup() {
    let root = std::env::temp_dir().join(format!("ftpeach-marker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let marker = root.join("vault-migration.json");
    let backup = root.join("vault-migration.last-good.bak");
    let body = r#"{"schemaVersion":1,"data":{"version":1,"status":"complete"}}"#;
    std::fs::write(&marker, body).unwrap();
    std::fs::write(&backup, body).unwrap();
    let store = Store::new_at(root.clone());
    store.clear_vault_secret_flags().await.unwrap();
    assert!(!marker.exists() && !backup.exists());

    // A backup an earlier version left behind is dropped at startup.
    std::fs::write(&backup, body).unwrap();
    store.scrub_secret_backups().await;
    assert!(!backup.exists());
    assert!(store.storage_warnings().is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn settings_commit_failure_restores_the_vault_proxy_password() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = std::env::temp_dir().join(format!(
        "ftpeach-proxy-transaction-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());
    vault.setup("correct horse battery staple").await.unwrap();
    store
        .set_settings_with_vault(proxy_patch(json!({"proxyPassword": "original"})), &vault)
        .await
        .unwrap();
    let original = std::fs::read(root.join("settings.json")).unwrap();
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.join("settings.json"))
        .unwrap();
    for patch in [
        json!({"proxyPassword": "replacement"}),
        json!({"removeProxyPassword": true}),
    ] {
        assert!(
            store
                .set_settings_with_vault(proxy_patch(patch), &vault)
                .await
                .is_err()
        );
        assert_eq!(
            vault
                .get_proxy_password()
                .await
                .unwrap()
                .unwrap()
                .as_slice(),
            b"original"
        );
        assert_eq!(std::fs::read(root.join("settings.json")).unwrap(), original);
    }
    drop(deny_replace);
    vault.lock().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn import_rollback_snapshot_retains_secret_fields() {
    let root =
        std::env::temp_dir().join(format!("ftpeach-import-snapshot-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::new_at(root.clone());
    let original = json!([{"id":"site", "name":"Site", "protocol":"ftp", "host":"example.test", "enc":"opaque-encrypted-secret", "keyEnc":"opaque-encrypted-key"}]);
    store
        .write_json(&root.join("sites.json"), &original)
        .await
        .unwrap();
    let snapshot = store.snapshot_sites_for_import().await.unwrap();
    store
        .write_json(&root.join("sites.json"), &json!([]))
        .await
        .unwrap();
    store.replace_sites_for_import(&snapshot).await.unwrap();
    let restored: Value = store.read_json(&root.join("sites.json"), Value::Null).await;
    assert_eq!(restored, original);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn downgrade_and_read_errors_never_overwrite_store() {
    let root =
        std::env::temp_dir().join(format!("ftpeach-storage-budget-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("settings.json");
    let future = br#"{"schemaVersion":99,"data":{"theme":"future"}}"#;
    std::fs::write(&path, future).unwrap();
    let store = Store::new_at(root.clone());
    let _ = store.get_settings().await;
    assert!(!store.storage_warnings().is_empty());
    assert!(store.set_settings(JsonMap::new()).await.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), future);
    let reopened = Store::new_at(root.clone());
    assert!(reopened.write_json(&path, &json!({})).await.is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let unreadable = Store::new_at(root.clone());
    let _ = unreadable.get_settings().await;
    assert!(unreadable.set_settings(JsonMap::new()).await.is_err());
    assert!(path.is_dir());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn last_good_recovery_is_observable_and_preserves_backup() {
    let root =
        std::env::temp_dir().join(format!("ftpeach-storage-recovery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("settings.json");
    let backup = path.with_extension("last-good.bak");
    std::fs::write(&backup, br#"{"schemaVersion":1,"data":{"theme":"dark"}}"#).unwrap();
    for missing in [true, false] {
        if !missing {
            std::fs::write(&path, b"broken").unwrap();
        }
        let store = Store::new_at(root.clone());
        assert_eq!(
            store.get_settings().await.get("theme"),
            Some(&json!("dark"))
        );
        assert!(!store.storage_warnings().is_empty());
        store.set_settings(JsonMap::new()).await.unwrap();
        assert!(std::fs::read_to_string(&backup).unwrap().contains("dark"));
    }
    std::fs::remove_dir_all(root).unwrap();
}

fn stored_payload<T: serde::de::DeserializeOwned>(raw: &str, path: &Path) -> T {
    let value: Value = serde_json::from_str(raw).unwrap();
    serde_json::from_value(decode_versioned_store(path, value).unwrap()).unwrap()
}

#[test]
fn dpapi_failure_never_returns_a_plaintext_field() {
    let secret = "must-not-reach-disk";
    let (field, not_persisted) = Store::encrypt_secret_with(secret, None, "enc", "plain", |_| {
        Err(anyhow::anyhow!("DPAPI unavailable"))
    });

    assert!(field.is_none());
    assert!(not_persisted);
}

#[test]
fn empty_secret_needs_no_persisted_field_or_warning() {
    let (field, not_persisted) =
        Store::encrypt_secret_with("", None, "enc", "plain", |_| unreachable!());

    assert!(field.is_none());
    assert!(!not_persisted);
}

#[test]
fn empty_secret_keeps_an_existing_encrypted_value() {
    let mut existing = JsonMap::new();
    existing.insert("enc".into(), Value::String("existing-ciphertext".into()));

    let (field, not_persisted) =
        Store::encrypt_secret_with("", Some(&existing), "enc", "plain", |_| unreachable!());

    assert_eq!(
        field,
        Some(("enc".into(), Value::String("existing-ciphertext".into())))
    );
    assert!(!not_persisted);
}

#[tokio::test]
async fn site_list_exposes_secret_flags_but_never_secret_values() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("sites.json"),
        r#"[{"id":"site-1","kind":"site","enc":"ciphertext","keyEnc":"key-ciphertext"}]"#,
    )
    .await
    .unwrap();

    let sites = store.list_sites().await.unwrap();

    assert_eq!(sites[0].get("hasPassword"), Some(&Value::Bool(true)));
    assert_eq!(sites[0].get("hasKeyPassphrase"), Some(&Value::Bool(true)));
    assert!(sites[0].get("password").is_none());
    assert!(sites[0].get("keyPassphrase").is_none());
    let serialized = serde_json::to_string(&sites).unwrap();
    assert!(!serialized.contains("ciphertext"));

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn apply_layout_validates_parents_and_rejects_incomplete_or_unknown_ids() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("sites.json"),
        r#"[
            {"id":"folder-1","kind":"folder","name":"Folder","parentId":null},
            {"id":"site-1","kind":"site","name":"Site","parentId":null},
            {"id":"site-2","kind":"site","name":"Other","parentId":null}
        ]"#,
    )
    .await
    .unwrap();

    let entry = |id: &str, parent_id: Option<&str>| SiteLayoutEntry {
        id: id.to_string(),
        parent_id: parent_id.map(str::to_string),
    };

    assert!(
        store
            .apply_layout(vec![
                entry("folder-1", None),
                entry("site-1", Some("missing")),
                entry("site-2", None),
            ])
            .await
            .is_err()
    );
    assert!(
        store
            .apply_layout(vec![
                entry("folder-1", None),
                entry("site-1", Some("site-2")),
                entry("site-2", None),
            ])
            .await
            .is_err()
    );
    assert!(
        store
            .apply_layout(vec![
                entry("folder-1", Some("folder-1")),
                entry("site-1", None),
                entry("site-2", None),
            ])
            .await
            .is_err()
    );

    assert!(
        store
            .apply_layout(vec![entry("folder-1", None), entry("site-1", None)])
            .await
            .is_err()
    );
    assert!(
        store
            .apply_layout(vec![
                entry("folder-1", None),
                entry("site-1", None),
                entry("site-1", None),
            ])
            .await
            .is_err()
    );
    assert!(
        store
            .apply_layout(vec![
                entry("folder-1", None),
                entry("site-1", None),
                entry("unknown", None),
            ])
            .await
            .is_err()
    );

    // None of the rejected attempts above may have touched the stored
    // order or parents.
    let sites = store.list_sites().await.unwrap();
    assert!(
        sites
            .iter()
            .all(|e| e.get("parentId") == Some(&Value::Null))
    );

    // A valid layout reparents site-1 into folder-1 and reorders the
    // remaining entries in one atomic write.
    store
        .apply_layout(vec![
            entry("site-2", None),
            entry("folder-1", None),
            entry("site-1", Some("folder-1")),
        ])
        .await
        .unwrap();

    let sites = store.list_sites().await.unwrap();
    let ids: Vec<&str> = sites
        .iter()
        .map(|e| e.get("id").and_then(Value::as_str).unwrap())
        .collect();
    assert_eq!(ids, ["site-2", "folder-1", "site-1"]);
    let moved = sites
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some("site-1"))
        .unwrap();
    assert_eq!(
        moved.get("parentId").and_then(Value::as_str),
        Some("folder-1")
    );

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn kind_mismatched_save_and_delete_operations_are_rejected() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("sites.json"),
        r#"[
            {"id":"folder-1","kind":"folder","name":"Folder","parentId":null},
            {"id":"site-1","kind":"site","name":"Site","protocol":"ftp","host":"example.test","parentId":null}
        ]"#,
    )
    .await
    .unwrap();

    // sites_save must not silently turn an existing folder into a site.
    let mut site_over_folder = JsonMap::new();
    site_over_folder.insert("id".into(), Value::String("folder-1".into()));
    site_over_folder.insert("name".into(), Value::String("Folder".into()));
    site_over_folder.insert("protocol".into(), Value::String("ftp".into()));
    site_over_folder.insert("host".into(), Value::String("example.test".into()));
    assert!(store.save_site(site_over_folder).await.is_err());

    // sites_save_folder must not silently turn an existing site into a
    // folder.
    let mut folder_over_site = JsonMap::new();
    folder_over_site.insert("id".into(), Value::String("site-1".into()));
    folder_over_site.insert("name".into(), Value::String("Site".into()));
    assert!(store.save_folder(folder_over_site).await.is_err());

    assert!(store.delete_site("folder-1").await.is_err());
    assert!(store.delete_folder("site-1").await.is_err());

    let sites = store.list_sites().await.unwrap();
    assert_eq!(sites.len(), 2);

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn local_folder_bookmark_round_trips_without_connection_fields() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let mut local = JsonMap::new();
    local.insert("kind".into(), Value::String("local".into()));
    local.insert("name".into(), Value::String("Work".into()));
    local.insert("localPath".into(), Value::String(r"C:\Work".into()));

    let saved = store.save_site(local).await.unwrap();
    let entries = store.list_sites().await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].get("id").and_then(Value::as_str),
        Some(saved.id.as_str())
    );
    assert_eq!(
        entries[0].get("kind").and_then(Value::as_str),
        Some("local")
    );
    assert_eq!(
        entries[0].get("localPath").and_then(Value::as_str),
        Some(r"C:\Work")
    );
    assert!(entries[0].get("protocol").is_none());

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn corrupt_sites_store_recovers_the_last_known_good_snapshot() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let mut first = JsonMap::new();
    first.insert("name".into(), Value::String("First".into()));
    first.insert("protocol".into(), Value::String("ftp".into()));
    first.insert("host".into(), Value::String("first.test".into()));
    store.save_site(first).await.unwrap();

    let mut second = JsonMap::new();
    second.insert("name".into(), Value::String("Second".into()));
    second.insert("protocol".into(), Value::String("ftp".into()));
    second.insert("host".into(), Value::String("second.test".into()));
    store.save_site(second).await.unwrap();
    tokio::fs::write(dir.join("sites.json"), b"{broken")
        .await
        .unwrap();

    let recovered = store.list_sites().await.unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].get("name").and_then(Value::as_str),
        Some("First")
    );
    assert!(dir.join("sites.last-good.bak").exists());

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn save_site_rejects_missing_or_invalid_fields() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());

    fn base() -> JsonMap {
        let mut site = JsonMap::new();
        site.insert("name".into(), Value::String("Test".into()));
        site.insert("protocol".into(), Value::String("ftp".into()));
        site.insert("host".into(), Value::String("example.test".into()));
        site
    }

    let mut missing_name = base();
    missing_name.remove("name");
    assert!(store.save_site(missing_name).await.is_err());

    let mut blank_name = base();
    blank_name.insert("name".into(), Value::String("   ".into()));
    assert!(store.save_site(blank_name).await.is_err());

    let mut bad_protocol = base();
    bad_protocol.insert("protocol".into(), Value::String("gopher".into()));
    assert!(store.save_site(bad_protocol).await.is_err());

    let mut missing_host = base();
    missing_host.remove("host");
    assert!(store.save_site(missing_host).await.is_err());

    let mut webdav_missing_url = base();
    webdav_missing_url.insert("protocol".into(), Value::String("webdav".into()));
    webdav_missing_url.remove("host");
    assert!(store.save_site(webdav_missing_url).await.is_err());

    let mut out_of_range_port = base();
    out_of_range_port.insert("port".into(), Value::from(70_000u32));
    assert!(store.save_site(out_of_range_port).await.is_err());

    let mut zero_port = base();
    zero_port.insert("port".into(), Value::from(0u32));
    assert!(store.save_site(zero_port).await.is_err());

    let mut bad_parent_type = base();
    bad_parent_type.insert("parentId".into(), Value::from(42));
    assert!(store.save_site(bad_parent_type).await.is_err());

    // A fully valid record still saves successfully.
    assert!(store.save_site(base()).await.is_ok());

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn save_folder_rejects_missing_or_blank_name() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());

    assert!(store.save_folder(JsonMap::new()).await.is_err());

    let mut blank = JsonMap::new();
    blank.insert("name".into(), Value::String("   ".into()));
    assert!(store.save_folder(blank).await.is_err());

    assert!(store.list_sites().await.unwrap().is_empty());
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn save_folder_ignores_a_renderer_supplied_parent() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let mut folder = JsonMap::new();
    folder.insert("name".into(), Value::String("Nested".into()));
    folder.insert("parentId".into(), Value::String("parent-folder".into()));

    let id = store.save_folder(folder).await.unwrap();
    let sites = store.list_sites().await.unwrap();
    let saved = sites
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .unwrap();
    assert_eq!(saved.get("parentId"), Some(&Value::Null));

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn save_folder_preserves_local_path_manager_scope() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let mut folder = JsonMap::new();
    folder.insert("name".into(), Value::String("Projects".into()));
    folder.insert("managerScope".into(), Value::String("localPaths".into()));

    let id = store.save_folder(folder).await.unwrap();
    let sites = store.list_sites().await.unwrap();
    let saved = sites
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .unwrap();
    assert_eq!(
        saved.get("managerScope").and_then(Value::as_str),
        Some("localPaths")
    );

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn explicit_remove_password_deletes_only_the_saved_secret() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("sites.json"),
        r#"[{"id":"site-1","kind":"site","name":"Test","protocol":"ftp","host":"example.test","enc":"existing-ciphertext"}]"#,
    )
    .await
    .unwrap();
    let mut update = JsonMap::new();
    update.insert("id".into(), Value::String("site-1".into()));
    update.insert("name".into(), Value::String("Updated".into()));
    update.insert("protocol".into(), Value::String("ftp".into()));
    update.insert("host".into(), Value::String("example.test".into()));
    update.insert("removePassword".into(), Value::Bool(true));

    store
        .save_site_with_protector(update, None, |_| unreachable!())
        .await
        .unwrap();

    let raw = tokio::fs::read_to_string(dir.join("sites.json"))
        .await
        .unwrap();
    let sites: Vec<JsonMap> = stored_payload(&raw, &dir.join("sites.json"));
    assert_eq!(
        sites[0].get("name").and_then(Value::as_str),
        Some("Updated")
    );
    assert!(sites[0].get("enc").is_none());
    assert!(sites[0].get("plain").is_none());

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn dpapi_failure_does_not_write_the_secret_to_disk() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let secret = "must-not-reach-sites-json";
    let mut site = JsonMap::new();
    site.insert("name".into(), Value::String("Test".into()));
    site.insert("protocol".into(), Value::String("sftp".into()));
    site.insert("host".into(), Value::String("example.test".into()));
    site.insert("password".into(), Value::String(secret.into()));

    let result = store
        .save_site_with_protector(site, None, |_| Err(anyhow::anyhow!("DPAPI unavailable")))
        .await
        .unwrap();
    let raw = tokio::fs::read_to_string(dir.join("sites.json"))
        .await
        .unwrap();

    assert!(result.secret_not_persisted);
    assert!(!raw.contains(secret));
    assert!(!raw.contains("\"plain\""));
    assert!(!raw.contains("\"keyPlain\""));

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[test]
fn a_backup_keeps_only_secrets_the_live_file_still_holds() {
    use super::storage::backup_without_stale_secrets;
    let previous = json!([
        {"id": "kept", "enc": "AAA", "keyEnc": "BBB"},
        {"id": "moved", "enc": "CCC", "hasPassword": false},
        {"id": "legacy", "plain": "plaintext-secret", "name": "L"},
        {"id": "deleted", "enc": "DDD"}
    ]);
    let next = json!([
        {"id": "kept", "enc": "AAA", "keyEnc": "changed"},
        {"id": "moved", "hasPassword": true},
        {"id": "legacy", "plain": "plaintext-secret", "name": "L"}
    ]);
    assert_eq!(
        backup_without_stale_secrets(previous, &next),
        json!([
            {"id": "kept", "enc": "AAA"},
            {"id": "moved", "hasPassword": false},
            {"id": "legacy", "name": "L"},
            {"id": "deleted"}
        ])
    );
    let settings = json!({"proxyHost": "p", "proxyPasswordEnc": "E", "proxyPasswordPlain": "x"});
    assert_eq!(
        backup_without_stale_secrets(settings, &json!({"hasProxyPassword": true})),
        json!({"proxyHost": "p"})
    );
}

/// Every file the store writes, other than the vault's own.
fn store_files_text(dir: &std::path::Path) -> Vec<(String, String)> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with("vault."))
        .map(|name| {
            let text = std::fs::read_to_string(dir.join(&name)).unwrap_or_default();
            (name, text)
        })
        .collect()
}

#[cfg(windows)]
#[tokio::test]
async fn no_backup_keeps_a_secret_weaker_than_the_live_protection() {
    let root = std::env::temp_dir().join(format!("ftpeach-backups-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    // An old install: legacy plaintext in both stores, plus leftovers.
    std::fs::write(
        root.join("sites.json"),
        r#"[{"id":"s","name":"S","protocol":"ftp","host":"h","plain":"synthetic-site-secret"}]"#,
    )
    .unwrap();
    std::fs::write(
        root.join("settings.json"),
        r#"{"proxyHost":"p","proxyPasswordPlain":"synthetic-proxy-secret"}"#,
    )
    .unwrap();
    std::fs::write(root.join("sites.4242.1.tmp"), "synthetic-site-secret").unwrap();
    let store = Store::new_at(root.clone());
    let vault = Vault::new(root.clone());

    // Legacy plaintext -> DPAPI: no file may keep the plaintext.
    store
        .migrate_plaintext_secrets_with(Store::protect_secret)
        .await
        .unwrap();
    store
        .set_settings(proxy_patch(
            json!({"proxyPassword": "synthetic-proxy-secret"}),
        ))
        .await
        .unwrap();
    store.scrub_secret_backups().await;
    for (name, text) in store_files_text(&root) {
        assert!(!text.contains("synthetic-"), "{name}: {text}");
    }

    // DPAPI -> vault -> lock: no file outside the vault keeps DPAPI copies.
    vault.setup("correct horse battery staple").await.unwrap();
    store.migrate_secrets_to_vault(&vault).await.unwrap();
    vault.lock().await;
    for (name, text) in store_files_text(&root) {
        for field in [
            "\"enc\"",
            "\"plain\"",
            "proxyPasswordEnc",
            "proxyPasswordPlain",
        ] {
            assert!(!text.contains(field), "{name} keeps {field}: {text}");
        }
    }
    assert!(!root.join("sites.pre-stronghold.bak").exists());

    // Losing the live files must not bring the weaker format back.
    std::fs::remove_file(root.join("sites.json")).unwrap();
    std::fs::remove_file(root.join("settings.json")).unwrap();
    let recovered = Store::new_at(root.clone());
    let sites = recovered.list_sites().await.unwrap();
    assert!(sites.iter().all(|site| site.get("enc").is_none()));
    let settings = recovered.get_settings().await;
    assert!(settings.get("proxyPasswordEnc").is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn plaintext_secrets_are_migrated_only_after_successful_encryption() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let path = dir.join("sites.json");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        &path,
        r#"[{"id":"site-1","plain":"legacy-password","keyPlain":"legacy-passphrase"}]"#,
    )
    .await
    .unwrap();

    store
        .migrate_plaintext_secrets_with(|data| {
            let mut protected = b"protected:".to_vec();
            protected.extend_from_slice(data);
            Ok(protected)
        })
        .await
        .unwrap();

    let raw = tokio::fs::read_to_string(&path).await.unwrap();
    let sites: Vec<JsonMap> = stored_payload(&raw, &dir.join("sites.json"));
    assert!(!raw.contains("legacy-password"));
    assert!(!raw.contains("legacy-passphrase"));
    assert!(sites[0].get("plain").is_none());
    assert!(sites[0].get("keyPlain").is_none());
    assert!(sites[0].get("enc").is_some());
    assert!(sites[0].get("keyEnc").is_some());

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn electron_era_ciphertext_is_flagged_and_replaced_by_a_new_secret() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("sites.json"),
        r#"[{"id":"site-1","kind":"site","name":"Legacy","protocol":"ftp","host":"example.test","enc":"djExLWVsZWN0cm9uLWNpcGhlcnRleHQ="}]"#,
    )
    .await
    .unwrap();

    assert!(store.has_undecryptable_secret().await);
    let mut replacement = JsonMap::new();
    replacement.insert("id".into(), Value::String("site-1".into()));
    replacement.insert("name".into(), Value::String("Legacy".into()));
    replacement.insert("protocol".into(), Value::String("ftp".into()));
    replacement.insert("host".into(), Value::String("example.test".into()));
    replacement.insert("password".into(), Value::String("replacement".into()));
    store
        .save_site_with_protector(replacement, None, |bytes| {
            let mut protected = b"dpapi:".to_vec();
            protected.extend_from_slice(bytes);
            Ok(protected)
        })
        .await
        .unwrap();

    let raw = tokio::fs::read_to_string(dir.join("sites.json"))
        .await
        .unwrap();
    let sites: Vec<JsonMap> = stored_payload(&raw, &dir.join("sites.json"));
    assert!(!raw.contains("djExLWVsZWN0cm9uLWNpcGhlcnRleHQ="));
    assert!(!raw.contains("replacement"));
    assert_eq!(
        sites[0].get("enc").and_then(Value::as_str),
        Some("ZHBhcGk6cmVwbGFjZW1lbnQ=")
    );

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn plaintext_migration_keeps_secrets_when_encryption_fails() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let path = dir.join("sites.json");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let original = r#"[{"id":"site-1","plain":"legacy-password","keyPlain":"legacy-passphrase"}]"#;
    tokio::fs::write(&path, original).await.unwrap();

    store
        .migrate_plaintext_secrets_with(|_| Err(anyhow::anyhow!("DPAPI unavailable")))
        .await
        .unwrap();

    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[cfg(windows)]
#[tokio::test]
async fn a_secret_that_cannot_be_encrypted_is_not_reported_as_saved() {
    let root = std::env::temp_dir().join(format!("ftpeach-secret-fail-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(root.clone());
    let refuse = |_: &[u8]| Err(anyhow::anyhow!("DPAPI unavailable"));
    let settings_raw = || std::fs::read_to_string(root.join("settings.json")).unwrap();

    store
        .set_settings(proxy_patch(json!({"proxyPassword": "first-secret"})))
        .await
        .unwrap();
    let saved = settings_raw();

    // The new proxy password cannot be protected: nothing is saved, the
    // caller hears about it, and the previous password still works.
    let error = store
        .set_settings_with_protector(
            proxy_patch(json!({"proxyPassword": "second-secret", "proxyPort": 1081})),
            refuse,
        )
        .await
        .unwrap_err();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&error).code,
        crate::ipc::ErrorCode::Internal
    );
    assert_eq!(settings_raw(), saved);
    assert!(!settings_raw().contains("second-secret"));
    let vault = Vault::new(root.clone());
    assert_eq!(
        connect_proxy_password(&store, &vault).await.as_deref(),
        Some("first-secret")
    );

    // The same for a site: the password saved before is kept.
    let site: JsonMap = serde_json::from_value(
        json!({"id":"s", "name":"S", "protocol":"ftp", "host":"h", "password":"site-first"}),
    )
    .unwrap();
    store.save_site(site.clone()).await.unwrap();
    let mut replacement = site;
    replacement.insert("password".into(), json!("site-second"));
    let outcome = store
        .save_site_with_protector(replacement, None, refuse)
        .await
        .unwrap();
    assert!(outcome.secret_not_persisted);
    let sites = std::fs::read_to_string(root.join("sites.json")).unwrap();
    assert!(!sites.contains("site-second"), "{sites}");
    assert_eq!(
        store
            .connection_config_for_site("s")
            .await
            .unwrap()
            .get("password")
            .and_then(Value::as_str),
        Some("site-first")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn corrupt_settings_are_backed_up_before_falling_back_to_defaults() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let corrupt = br#"{"theme":"dark","truncated":"#;
    tokio::fs::write(dir.join("settings.json"), corrupt)
        .await
        .unwrap();

    let settings = store.get_settings().await;

    assert_eq!(settings.get("theme").and_then(Value::as_str), Some("dark"));
    let mut entries = tokio::fs::read_dir(&dir).await.unwrap();
    let mut backups = Vec::new();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("settings.corrupt-") && name.ends_with(".bak") {
            backups.push(entry.path());
        }
    }
    assert_eq!(backups.len(), 1);
    assert_eq!(tokio::fs::read(&backups[0]).await.unwrap(), corrupt);
    assert_eq!(
        tokio::fs::read(dir.join("settings.json")).await.unwrap(),
        corrupt
    );

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn layout_reset_keeps_the_log_open_or_closed_as_it_was() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    for open in [true, false] {
        store
            .set_settings(JsonMap::from_iter([
                ("logEnabled".into(), Value::Bool(open)),
                ("logPanelHeight".into(), Value::from(420)),
            ]))
            .await
            .unwrap();

        let settings = store.reset_layout_settings().await.unwrap();

        assert_eq!(settings.get("logEnabled"), Some(&Value::Bool(open)));
        assert_eq!(
            settings.get("logPanelHeight"),
            Store::default_settings().get("logPanelHeight")
        );
    }
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn concurrent_settings_updates_are_serialized_and_atomically_committed() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let first = store.clone();
    let second = store.clone();
    let first_update = tokio::spawn(async move {
        first
            .set_settings(JsonMap::from_iter([(
                "theme".into(),
                Value::String("light".into()),
            )]))
            .await
    });
    let second_update = tokio::spawn(async move {
        second
            .set_settings(JsonMap::from_iter([(
                "paneOrientation".into(),
                Value::String("vertical".into()),
            )]))
            .await
    });

    first_update.await.unwrap().unwrap();
    second_update.await.unwrap().unwrap();

    let raw = tokio::fs::read_to_string(dir.join("settings.json"))
        .await
        .unwrap();
    let stored: JsonMap = stored_payload(&raw, &dir.join("settings.json"));
    assert_eq!(stored.get("theme").and_then(Value::as_str), Some("light"));
    assert_eq!(
        stored.get("paneOrientation").and_then(Value::as_str),
        Some("vertical")
    );
    let leftovers = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0);

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn unavailable_data_directory_surfaces_a_write_error() {
    let parent = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&parent).await.unwrap();
    let not_a_directory = parent.join("blocked");
    tokio::fs::write(&not_a_directory, b"regular file")
        .await
        .unwrap();
    let store = Store::new_at(not_a_directory);

    let result = store
        .set_settings(JsonMap::from_iter([(
            "theme".into(),
            Value::String("light".into()),
        )]))
        .await;

    assert!(result.is_err());
    // The blocked path is the store directory itself, so the failure has to name
    // that -- not the tmp file whose creation fails only as a consequence.
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("creating the settings store directory")
    );
    let _ = tokio::fs::remove_dir_all(parent).await;
}

#[tokio::test]
async fn unreadable_target_fails_before_creating_a_temp_file() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(dir.join("settings.json"))
        .await
        .unwrap();
    let store = Store::new_at(dir.clone());

    let result = store
        .set_settings(JsonMap::from_iter([(
            "theme".into(),
            Value::String("light".into()),
        )]))
        .await;

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("read-only"));
    let leftovers = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn stronghold_migration_and_new_writes_fail_closed() {
    let dir = std::env::temp_dir().join(format!(
        "ftpeach-vault-migration-test-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Store::new_at(dir.clone());
    let vault = Vault::new(dir.clone());
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("sites.json"),
        r#"[{"id":"site-1","kind":"site","name":"Test","protocol":"ftp","host":"example.test","plain":"legacy-password","keyPlain":"legacy-passphrase"}]"#,
    )
    .await
    .unwrap();
    vault.setup("correct horse battery staple").await.unwrap();

    // SAFETY: on Windows (the only supported target) `set_var`/`remove_var`
    // go through SetEnvironmentVariableW, which the OS synchronizes with
    // concurrent reads — the POSIX `environ` data race that makes these
    // functions unsafe cannot occur here.
    unsafe { std::env::set_var("FTPEACH_SIMULATE_DPAPI_FAILURE", "1") };
    assert!(store.migrate_secrets_to_vault(&vault).await.is_err());
    unsafe { std::env::remove_var("FTPEACH_SIMULATE_DPAPI_FAILURE") };
    let raw = tokio::fs::read_to_string(dir.join("sites.json"))
        .await
        .unwrap();
    assert!(raw.contains("legacy-password"));
    assert!(raw.contains("legacy-passphrase"));
    assert!(!dir.join("sites.pre-stronghold.bak").exists());

    let mut site = JsonMap::new();
    site.insert("id".into(), Value::String("site-2".into()));
    site.insert("kind".into(), Value::String("site".into()));
    site.insert("name".into(), Value::String("Vault site".into()));
    site.insert("protocol".into(), Value::String("ftp".into()));
    site.insert("host".into(), Value::String("example.test".into()));
    site.insert(
        "password".into(),
        Value::String("new-vault-password".into()),
    );
    store
        .save_site_with_vault(site, None, &vault)
        .await
        .unwrap();
    let raw = tokio::fs::read_to_string(dir.join("sites.json"))
        .await
        .unwrap();
    assert!(!raw.contains("new-vault-password"));
    let sites: Vec<JsonMap> = stored_payload(&raw, &dir.join("sites.json"));
    assert_eq!(sites[1].get("hasPassword"), Some(&Value::Bool(true)));
    let config = store
        .connection_config_for_site_with_vault("site-2", &vault)
        .await
        .unwrap();
    assert_eq!(config["password"], "new-vault-password");

    vault.lock().await;
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[test]
fn reads_legacy_and_current_store_schemas() {
    let sites_path = Path::new("sites.json");
    let legacy = json!([{"id": "legacy", "kind": "site"}]);
    assert_eq!(
        decode_versioned_store(sites_path, legacy.clone()).unwrap(),
        legacy
    );

    let current = json!({"schemaVersion": 1, "data": [{"id": "current"}]});
    assert_eq!(
        decode_versioned_store(sites_path, current).unwrap(),
        json!([{"id": "current"}])
    );

    let settings_path = Path::new("settings.json");
    let legacy_settings = json!({"theme": "light", "splitRatio": 0.4});
    assert_eq!(
        decode_versioned_store(settings_path, legacy_settings.clone()).unwrap(),
        legacy_settings
    );
    let current_settings =
        json!({"schemaVersion": 1, "data": {"theme": "dark", "splitRatio": 0.5}});
    assert_eq!(
        decode_versioned_store(settings_path, current_settings).unwrap(),
        json!({"theme": "dark", "splitRatio": 0.5})
    );

    assert_eq!(
        encode_versioned_store(settings_path, json!({"theme": "dark"})),
        json!({"schemaVersion": 1, "data": {"theme": "dark"}})
    );
    assert_eq!(
        encode_versioned_store(sites_path, json!([{"id": "site-1"}])),
        json!({"schemaVersion": 1, "data": [{"id": "site-1"}]})
    );
    let tabs_path = Path::new("tabs.json");
    let tabs = json!({"activeTabId": "tab-1", "tabs": [{"id": "tab-1"}]});
    assert_eq!(
        decode_versioned_store(tabs_path, tabs.clone()).unwrap(),
        tabs
    );
    assert_eq!(
        encode_versioned_store(tabs_path, tabs.clone()),
        json!({"schemaVersion": 1, "data": tabs})
    );
}

#[test]
fn rejects_unknown_store_schema_without_interpreting_payload() {
    let error = decode_versioned_store(
        Path::new("known_hosts.json"),
        json!({"schemaVersion": 999, "data": {"host:22": "fingerprint"}}),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("unsupported known_hosts.json schema version 999")
    );
}

fn local_folder(name: &str) -> JsonMap {
    let mut folder = JsonMap::new();
    folder.insert("name".into(), Value::String(name.into()));
    folder.insert("managerScope".into(), Value::String("localPaths".into()));
    folder
}

#[tokio::test]
async fn local_paths_read_the_legacy_array_and_are_saved_versioned() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("local-paths.json");
    std::fs::write(
        &path,
        br#"[{"id":"legacy","kind":"folder","name":"Old","managerScope":"localPaths"}]"#,
    )
    .unwrap();
    let store = Store::new_at(dir.clone());
    let names = |sites: Vec<JsonMap>| -> Vec<String> {
        sites
            .iter()
            .filter_map(|site| site.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect()
    };
    assert_eq!(names(store.list_sites().await.unwrap()), ["Old"]);

    store.save_folder(local_folder("New")).await.unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], json!(1));
    assert_eq!(names(store.list_sites().await.unwrap()), ["Old", "New"]);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn local_paths_of_an_unknown_future_version_stay_read_only() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("local-paths.json");
    let future = br#"{"schemaVersion":2,"data":{"folders":[]}}"#;
    std::fs::write(&path, future).unwrap();
    let store = Store::new_at(dir.clone());
    let _ = store.list_sites().await;
    assert!(!store.storage_warnings().is_empty());
    assert!(store.save_folder(local_folder("New")).await.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), future);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_store_of_the_wrong_shape_never_becomes_the_last_good_backup() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("local-paths.json");
    let backup = path.with_extension("last-good.bak");
    let good = r#"{"schemaVersion":1,"data":[{"id":"kept","kind":"folder","name":"Kept","managerScope":"localPaths"}]}"#;
    std::fs::write(&backup, good).unwrap();
    std::fs::write(&path, br#"{"schemaVersion":1,"data":{"not":"a list"}}"#).unwrap();

    let store = Store::new_at(dir.clone());
    let recovered = store.list_sites().await.unwrap();
    assert_eq!(recovered.len(), 1);
    store
        .write_json(&path, &Vec::<JsonMap>::new())
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), good);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_failed_backup_update_is_reported_and_keeps_the_save() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    std::fs::write(&path, br#"{"schemaVersion":1,"data":{"theme":"dark"}}"#).unwrap();
    // A directory where the backup goes makes publishing it fail, the way
    // an interrupted or refused rename would.
    std::fs::create_dir(path.with_extension("last-good.bak")).unwrap();
    let store = Store::new_at(dir.clone());
    store
        .write_json(&path, &json!({"theme": "light"}))
        .await
        .unwrap();

    assert!(
        store
            .storage_warnings()
            .iter()
            .any(|warning| warning.contains("last-good backup not updated"))
    );
    assert!(std::fs::read_to_string(&path).unwrap().contains("light"));
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn rereading_a_corrupt_store_keeps_one_copy_and_a_bounded_history() {
    let dir = std::env::temp_dir().join(format!("ftpeach-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sites.json");
    let copies = || {
        std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("sites.corrupt-")
            })
            .count()
    };
    std::fs::write(&path, b"{broken").unwrap();
    for _ in 0..5 {
        let _ = Store::new_at(dir.clone()).list_sites().await;
    }
    assert_eq!(copies(), 1);

    for n in 0..10 {
        std::fs::write(&path, format!("{{broken {n}")).unwrap();
        let _ = Store::new_at(dir.clone()).list_sites().await;
    }
    assert_eq!(copies(), 5);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

/// A saved password reaches a new server only through the move the user
/// confirmed (HF-39), checked against the bookmark as the save writes it.
mod saved_password_recipient {
    use super::*;
    use crate::security::credential_scope::{SecretTransfer, site_save_transfer};
    use crate::store::sites::SaveSiteOutcome;

    const OLD_SECRET: &str = "recipient-test-old-secret";

    fn map(value: Value) -> JsonMap {
        serde_json::from_value(value).unwrap()
    }

    fn original() -> JsonMap {
        map(
            json!({"id":"s", "name":"S", "protocol":"ftp", "host":"a.example", "user":"u", "password": OLD_SECRET}),
        )
    }

    /// The bookmark moved to `b.example`, keeping its saved password.
    fn to_new_host() -> JsonMap {
        let mut edited = original();
        edited.remove("password");
        edited.insert("host".into(), json!("b.example"));
        edited
    }

    async fn recipient(store: &Store, vault: Option<&Vault>) -> (String, String) {
        let config = match vault {
            Some(vault) => {
                store
                    .connection_config_for_site_with_vault("s", vault)
                    .await
            }
            None => store.connection_config_for_site("s").await,
        }
        .unwrap();
        let text = |key: &str| config[key].as_str().unwrap_or("").to_owned();
        (text("host"), text("password"))
    }

    fn unchanged() -> (String, String) {
        ("a.example".into(), OLD_SECRET.into())
    }

    /// The transfer `sites_save` binds its grant to for this payload.
    async fn transfer_for(store: &Store, payload: &JsonMap) -> Option<SecretTransfer> {
        site_save_transfer(store.saved_site_credentials("s").await.as_ref(), payload)
    }

    async fn save(
        store: &Store,
        vault: Option<&Vault>,
        payload: JsonMap,
        confirmed: Option<&SecretTransfer>,
    ) -> Result<SaveSiteOutcome> {
        match vault {
            Some(vault) => store.save_site_with_vault(payload, confirmed, vault).await,
            None => {
                store
                    .save_site_with_protector(payload, confirmed, Store::protect_secret)
                    .await
            }
        }
    }

    async fn check_every_route(store: &Store, vault: Option<&Vault>) {
        save(store, vault, original(), None).await.unwrap();

        // `password: true` names a new password in an authorization request
        // only; a folder is not a server. Neither reaches the store as a
        // replaced password or as a bookmark without a recipient.
        for bypass in [
            json!({"password": true}),
            json!({"password": 1}),
            json!({"kind": "folder"}),
            json!({"kind": "server"}),
            json!({"removePassword": "yes"}),
        ] {
            let mut payload = to_new_host();
            payload.extend(map(bypass.clone()));
            let transfer = transfer_for(store, &payload).await;
            assert!(
                save(store, vault, payload, transfer.as_ref())
                    .await
                    .is_err(),
                "{bypass}"
            );
            assert_eq!(recipient(store, vault).await, unchanged(), "{bypass}");
        }

        // A move nobody confirmed is refused, whatever the caller skipped.
        let error = save(store, vault, to_new_host(), None)
            .await
            .err()
            .expect("an unconfirmed move must be refused");
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::PermissionDenied
        );
        assert_eq!(recipient(store, vault).await, unchanged());

        // Display labels do not include the CA or every TLS setting. Both
        // the grant and the transaction must bind the full destination scope.
        let mut approved = to_new_host();
        approved.insert("caCertPath".into(), json!("C:\\approved-ca.pem"));
        let confirmed = transfer_for(store, &approved).await;
        let granted =
            crate::security::credential_scope::site_save_target(&approved, confirmed.as_ref());
        for (key, value) in [
            ("caCertPath", json!("C:\\different-ca.pem")),
            ("secure", json!(true)),
            ("allowInvalidCert", json!(true)),
            ("allowCleartextAuth", json!(true)),
        ] {
            let mut changed = approved.clone();
            changed.insert(key.into(), value);
            let actual = transfer_for(store, &changed).await;
            assert_ne!(
                granted,
                crate::security::credential_scope::site_save_target(&changed, actual.as_ref()),
                "{key} must be part of the grant"
            );
            assert!(
                save(store, vault, changed, confirmed.as_ref())
                    .await
                    .is_err(),
                "{key}"
            );
            assert_eq!(recipient(store, vault).await, unchanged());
        }

        // A move confirmed for a bookmark that changed since is refused too.
        let stale = transfer_for(store, &to_new_host()).await;
        assert!(stale.is_some());
        let mut elsewhere = original();
        elsewhere.remove("password");
        elsewhere.insert("port".into(), json!(2121));
        let port_move = transfer_for(store, &elsewhere).await;
        save(store, vault, elsewhere, port_move.as_ref())
            .await
            .unwrap();
        assert!(
            save(store, vault, to_new_host(), stale.as_ref())
                .await
                .is_err()
        );
        assert_eq!(
            recipient(store, vault).await,
            unchanged(),
            "the confirmed port move keeps host and password"
        );

        // The move the user confirmed goes through.
        let confirmed = transfer_for(store, &to_new_host()).await;
        save(store, vault, to_new_host(), confirmed.as_ref())
            .await
            .unwrap();
        assert_eq!(
            recipient(store, vault).await,
            ("b.example".into(), OLD_SECRET.into())
        );
    }

    #[tokio::test]
    async fn with_system_protection() {
        let root = std::env::temp_dir().join(format!("ftpeach-recipient-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(root.clone());
        check_every_route(&store, None).await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn with_the_vault() {
        let root =
            std::env::temp_dir().join(format!("ftpeach-recipient-vault-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(root.clone());
        let vault = Vault::new(root.clone());
        vault.setup("correct horse battery staple").await.unwrap();
        check_every_route(&store, Some(&vault)).await;
        std::fs::remove_dir_all(root).unwrap();
    }

    /// HF-09 with HF-39: a new password that cannot be protected is not
    /// saved, so the old one would go to the new server. The whole save is
    /// refused and the bookmark stays as it was.
    #[tokio::test]
    async fn a_new_server_whose_new_password_cannot_be_protected_is_not_saved() {
        let root =
            std::env::temp_dir().join(format!("ftpeach-recipient-failed-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(root.clone());
        store.save_site(original()).await.unwrap();
        let before = std::fs::read(root.join("sites.json")).unwrap();
        let mut payload = to_new_host();
        payload.insert("password".into(), json!("recipient-test-new-secret"));
        // Replacing the password needs no confirmation, so none was given.
        let transfer = transfer_for(&store, &payload).await;
        assert_eq!(transfer, None);

        let error = store
            .save_site_with_protector(payload, None, |_| anyhow::bail!("injected DPAPI failure"))
            .await
            .err()
            .expect("the save must be refused");

        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::Internal
        );
        assert_eq!(std::fs::read(root.join("sites.json")).unwrap(), before);
        assert_eq!(recipient(&store, None).await, unchanged());
        std::fs::remove_dir_all(root).unwrap();
    }
}
