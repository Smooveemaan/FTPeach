use super::*;

#[test]
fn import_result_sites_added_is_camel_case() {
    let value = serde_json::to_value(ImportResult::Ok {
        ok: true,
        settings: None,
        sites_added: 3,
        sites_skipped: 0,
    })
    .unwrap();
    assert!(
        value.get("sitesAdded").is_some(),
        "expected sitesAdded, got {value}"
    );
}

#[test]
fn export_strips_plaintext_encrypted_and_legacy_secret_fields() {
    let settings = JsonMap::from_iter([
        ("theme".into(), serde_json::Value::String("dark".into())),
        (
            "proxyPasswordEnc".into(),
            serde_json::Value::String("ciphertext".into()),
        ),
        (
            "proxyPasswordPlain".into(),
            serde_json::Value::String("legacy-secret".into()),
        ),
    ]);
    let site = JsonMap::from_iter([
        ("name".into(), serde_json::Value::String("Example".into())),
        (
            "password".into(),
            serde_json::Value::String("password".into()),
        ),
        (
            "keyPassphrase".into(),
            serde_json::Value::String("passphrase".into()),
        ),
        ("enc".into(), serde_json::Value::String("ciphertext".into())),
        (
            "keyPlain".into(),
            serde_json::Value::String("legacy-passphrase".into()),
        ),
        ("hasPassword".into(), serde_json::Value::Bool(true)),
        ("hasKeyPassphrase".into(), serde_json::Value::Bool(true)),
    ]);

    let settings = strip_settings_secrets(settings);
    let site = strip_site_secrets(site);
    for key in ["proxyPasswordEnc", "proxyPasswordPlain", "proxyPassword"] {
        assert!(
            !settings.contains_key(key),
            "unexpected exported field {key}"
        );
    }
    for key in ["password", "keyPassphrase", "enc", "keyPlain"] {
        assert!(!site.contains_key(key), "unexpected exported field {key}");
    }
    assert_eq!(
        site.get("hasPassword"),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        site.get("hasKeyPassphrase"),
        Some(&serde_json::Value::Bool(false))
    );
}

#[test]
fn imported_site_cannot_inject_any_supported_secret_representation() {
    let site = JsonMap::from_iter([
        ("id".into(), serde_json::Value::String("source-id".into())),
        ("name".into(), serde_json::Value::String("Example".into())),
        ("plain".into(), serde_json::Value::String("legacy".into())),
        ("keyEnc".into(), serde_json::Value::String("cipher".into())),
        ("removePassword".into(), serde_json::Value::Bool(true)),
    ]);

    let mut imported = strip_site_secrets(site);
    imported.remove("id");

    assert_eq!(
        imported.get("name").and_then(serde_json::Value::as_str),
        Some("Example")
    );
    for key in ["id", "plain", "keyEnc", "removePassword"] {
        assert!(
            !imported.contains_key(key),
            "unexpected imported field {key}"
        );
    }
}

#[tokio::test]
async fn bookmark_import_remaps_folders_and_strips_secrets() {
    let dir = std::env::temp_dir().join(format!("ftpeach-import-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let sites = vec![
        serde_json::json!({"id":"old-bookmark-folder","kind":"folder","name":"Imported"}),
        serde_json::json!({
            "id":"old-local-folder","kind":"folder","name":"Imported",
            "managerScope":"localPaths"
        }),
        serde_json::json!({
            "id":"old-site","kind":"site","name":"Server","protocol":"ftp",
            "host":"example.test","parentId":"old-bookmark-folder","password":"secret"
        }),
        serde_json::json!({
            "id":"old-local","kind":"local","name":"Work","localPath":"C:\\Work",
            "parentId":"old-local-folder"
        }),
    ];

    let outcome = import_sites(&store, sites, &[]).await.unwrap();
    assert_eq!(outcome.added, 4);
    assert_eq!(outcome.skipped, 0);
    let imported = store.list_sites().await.unwrap();
    let bookmark_folder_id = imported
        .iter()
        .find(|entry| {
            entry["kind"] == "folder"
                && entry.get("managerScope").and_then(Value::as_str) != Some("localPaths")
        })
        .and_then(|entry| entry["id"].as_str())
        .unwrap();
    let local_folder_id = imported
        .iter()
        .find(|entry| entry.get("managerScope").and_then(Value::as_str) == Some("localPaths"))
        .and_then(|entry| entry["id"].as_str())
        .unwrap();
    let site = imported
        .iter()
        .find(|entry| entry["kind"] == "site")
        .unwrap();
    let local = imported
        .iter()
        .find(|entry| entry["kind"] == "local")
        .unwrap();
    assert_eq!(site["parentId"].as_str(), Some(bookmark_folder_id));
    assert_eq!(local["parentId"].as_str(), Some(local_folder_id));
    assert!(site.get("password").is_none());
    assert_ne!(site["id"].as_str(), Some("old-site"));
    assert_ne!(local["id"].as_str(), Some("old-local"));

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn legacy_folder_shared_across_both_kinds_falls_back_the_mismatched_child_to_root() {
    let dir = std::env::temp_dir().join(format!("ftpeach-import-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let sites = vec![
        serde_json::json!({"id":"old-folder","kind":"folder","name":"Mixed"}),
        serde_json::json!({
            "id":"old-site","kind":"site","name":"Server","protocol":"ftp",
            "host":"example.test","parentId":"old-folder"
        }),
        serde_json::json!({
            "id":"old-local","kind":"local","name":"Work","localPath":"C:\\Work",
            "parentId":"old-folder"
        }),
    ];

    let outcome = import_sites(&store, sites, &[]).await.unwrap();
    assert_eq!(outcome.added, 3);
    assert_eq!(outcome.skipped, 0);
    let imported = store.list_sites().await.unwrap();
    let folder_id = imported
        .iter()
        .find(|entry| entry["kind"] == "folder")
        .and_then(|entry| entry["id"].as_str())
        .unwrap();
    let site = imported
        .iter()
        .find(|entry| entry["kind"] == "site")
        .unwrap();
    let local = imported
        .iter()
        .find(|entry| entry["kind"] == "local")
        .unwrap();
    assert_eq!(site["parentId"].as_str(), Some(folder_id));
    assert_eq!(local["parentId"], serde_json::Value::Null);

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn reimporting_the_same_bookmarks_skips_exact_duplicates() {
    let dir = std::env::temp_dir().join(format!("ftpeach-import-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let sites = || {
        vec![
            serde_json::json!({"id":"old-bookmark-folder","kind":"folder","name":"Imported"}),
            serde_json::json!({
                "id":"old-local-folder","kind":"folder","name":"Imported",
                "managerScope":"localPaths"
            }),
            serde_json::json!({
                "id":"old-site","kind":"site","name":"Server","protocol":"ftp",
                "host":"Example.test","port":21,"user":"me","parentId":"old-bookmark-folder"
            }),
            serde_json::json!({
                "id":"old-local","kind":"local","name":"Work","localPath":"C:\\Work",
                "parentId":"old-local-folder"
            }),
        ]
    };

    let first = import_sites(&store, sites(), &[]).await.unwrap();
    assert_eq!((first.added, first.skipped), (4, 0));

    let existing = store.list_sites().await.unwrap();
    let second = import_sites(&store, sites(), &existing).await.unwrap();
    assert_eq!((second.added, second.skipped), (0, 4));

    let after = store.list_sites().await.unwrap();
    assert_eq!(after.len(), existing.len(), "no new entries should appear");

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[test]
fn import_schema_rejects_unknown_secret_wrong_type_and_out_of_range_fields() {
    for patch in [
        serde_json::json!({"futureSetting": true}),
        serde_json::json!({"proxyPasswordEnc": "ciphertext"}),
        serde_json::json!({"concurrency": "many"}),
        serde_json::json!({"proxyPort": 70000}),
    ] {
        assert!(validate_import_settings(patch.as_object().unwrap()).is_err());
    }
    assert!(
        validate_import_settings(
            serde_json::json!({"concurrency": 128, "proxyPort": 65535})
                .as_object()
                .unwrap()
        )
        .is_ok()
    );

    let secret_site = serde_json::json!({"kind":"site", "name":"Server", "protocol":"ftp", "host":"example.test", "plain":"secret"});
    assert!(validate_import_site(secret_site.as_object().unwrap(), 0).is_err());
}

#[test]
fn exported_site_round_trips_through_import_validation() {
    let site = JsonMap::from_iter([
        ("kind".into(), serde_json::Value::String("site".into())),
        ("name".into(), serde_json::Value::String("Server".into())),
        ("protocol".into(), serde_json::Value::String("ftp".into())),
        (
            "host".into(),
            serde_json::Value::String("example.test".into()),
        ),
        (
            "password".into(),
            serde_json::Value::String("secret".into()),
        ),
    ]);
    let exported = strip_site_secrets(site);
    assert!(validate_import_site(&exported, 0).is_ok());
}
