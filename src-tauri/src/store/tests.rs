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
        .save_site_with_vault(site.clone(), &vault)
        .await
        .unwrap();
    let original = std::fs::read(root.join("sites.json")).unwrap();
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.join("sites.json"))
        .unwrap();
    site.insert("password".into(), json!("replacement"));
    assert!(store.save_site_with_vault(site, &vault).await.is_err());
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
    assert!(
        store
            .delete_site_with_vault("site".into(), &vault)
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
    assert_eq!(std::fs::read(root.join("sites.json")).unwrap(), original);
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
        .save_site_with_protector(update, |_| unreachable!())
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
        .save_site_with_protector(site, |_| Err(anyhow::anyhow!("DPAPI unavailable")))
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
        .save_site_with_protector(replacement, |bytes| {
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
    store.save_site_with_vault(site, &vault).await.unwrap();
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
