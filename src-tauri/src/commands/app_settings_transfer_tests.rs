use super::*;

#[test]
fn import_result_sites_added_is_camel_case() {
    let value = serde_json::to_value(ImportResult::Ok {
        ok: true,
        settings: None,
        sites_added: 3,
        sites_skipped: 0,
        secrets_saved: 0,
        flags_restored: 0,
        scope_mismatches: Vec::new(),
        unmatched: Vec::new(),
    })
    .unwrap();
    assert!(
        value.get("sitesAdded").is_some(),
        "expected sitesAdded, got {value}"
    );
    // A bookmarks-only import carries no settings; null here was rejected by
    // `isImportSettingsResult` and shown as an unexpected error.
    assert!(
        value.get("settings").is_none(),
        "expected no settings key, got {value}"
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

/// Imports `sites` without secrets, as a file without them does.
async fn import_sites(store: &Store, sites: Vec<serde_json::Value>) -> SitesImported {
    let vault = Vault::new(store.data_dir().join("no-vault"));
    let records: Vec<JsonMap> = sites
        .into_iter()
        .map(|site| site.as_object().unwrap().clone())
        .collect();
    match store.import_sites(&vault, &records, HashMap::new()).await {
        Ok((outcome, _kept)) => outcome,
        Err(failed) => panic!("{:#}", failed.error),
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

    let outcome = import_sites(&store, sites).await;
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

    let outcome = import_sites(&store, sites).await;
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

    let first = import_sites(&store, sites()).await;
    assert_eq!((first.added, first.skipped), (4, 0));

    let existing = store.list_sites().await.unwrap();
    let second = import_sites(&store, sites()).await;
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
        ("maxConnections".into(), serde_json::json!(4)),
        ("encoding".into(), serde_json::json!("windows-1251")),
    ]);
    let exported = strip_site_secrets(site);
    assert_eq!(validate_import_site(&exported, 0), Ok(()));

    let mut unknown = exported;
    unknown.insert("encoding".into(), serde_json::json!("klingon"));
    assert!(validate_import_site(&unknown, 0).is_err());
}

#[test]
fn an_empty_or_foreign_file_is_named_as_not_a_settings_file() {
    let empty = serde_json::from_str::<ImportDocument>("").err().unwrap();
    assert!(parse_failure_reason(&empty).contains("not a settings file exported by FTPeach"));
    let foreign = serde_json::from_str::<ImportDocument>(r#"{"name":"x"}"#)
        .err()
        .unwrap();
    assert!(parse_failure_reason(&foreign).contains("unknown field `name`"));
}

fn options() -> ImportSettingsOptions {
    ImportSettingsOptions {
        include_settings: true,
        include_bookmarks: true,
        include_local_paths: true,
    }
}

fn document(value: serde_json::Value) -> ImportDocument {
    serde_json::from_value(value).unwrap()
}

fn site(id: &str, host: &str) -> serde_json::Value {
    serde_json::json!({"id": id, "kind": "site", "name": id, "protocol": "ftp", "host": host})
}

async fn sealed_for(sites: &[serde_json::Value], password: &str) -> serde_json::Value {
    let entries: Vec<SealEntry> = sites
        .iter()
        .map(|site| SealEntry {
            id: site["id"].as_str().unwrap(),
            scope: site_scope(site.as_object().unwrap()),
            password: Some("server password"),
            key_passphrase: None,
        })
        .collect();
    serde_json::to_value(export_secrets::seal(password, &entries).await.unwrap()).unwrap()
}

#[test]
fn a_file_with_repeated_ids_or_a_future_format_is_refused() {
    let repeated =
        document(serde_json::json!({"sites": [site("a", "a.test"), site("a", "b.test")]}));
    let issues = stage(repeated, &options(), "main").err().unwrap();
    assert!(
        issues.iter().any(|issue| issue.contains("appears twice")),
        "{issues:?}"
    );

    let future = document(serde_json::json!({"formatVersion": 3, "sites": []}));
    let issues = stage(future, &options(), "main").err().unwrap();
    assert!(issues[0].contains("newer FTPeach"), "{issues:?}");

    let unsealed = document(serde_json::json!({"formatVersion": 2, "sites": []}));
    assert!(stage(unsealed, &options(), "main").is_err());

    let old = document(serde_json::json!({"sites": [site("a", "a.test")]}));
    let staged = stage(old, &options(), "main").unwrap();
    assert!(staged.secrets.is_none());
}

#[tokio::test]
async fn the_file_password_opens_its_secrets_only_for_bookmarks_in_the_file() {
    let sites = [site("a", "a.test")];
    let file = document(serde_json::json!({
        "formatVersion": 2,
        "sites": sites,
        "secrets": sealed_for(&sites, "a long export password").await,
    }));
    let staged = stage(file, &options(), "main").unwrap();
    assert!(staged.secrets.is_some());

    let wrong = open_secrets(&staged, Some("not the export password"))
        .await
        .err()
        .unwrap();
    assert_eq!(wrong.code, ErrorCode::AuthFailed);
    assert!(open_secrets(&staged, None).await.unwrap().is_empty());
    let opened = open_secrets(&staged, Some("a long export password"))
        .await
        .unwrap();
    assert_eq!(
        opened["a"].password.as_ref().unwrap().expose(),
        "server password"
    );

    // A secret naming a bookmark the file does not have.
    let file = document(serde_json::json!({
        "formatVersion": 2,
        "sites": [site("b", "b.test")],
        "secrets": sealed_for(&sites, "a long export password").await,
    }));
    let staged = stage(file, &options(), "main").unwrap();
    let error = open_secrets(&staged, Some("a long export password"))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn importing_only_local_paths_never_asks_for_the_file_password() {
    let sites = [site("a", "a.test")];
    let file = document(serde_json::json!({
        "formatVersion": 2,
        "sites": sites,
        "secrets": sealed_for(&sites, "a long export password").await,
    }));
    let mut options = options();
    options.include_bookmarks = false;
    assert!(stage(file, &options, "main").unwrap().secrets.is_none());
}

#[test]
fn an_export_never_damages_a_file_beside_its_destination() {
    let dir = std::env::temp_dir().join(format!("ftpeach-export-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let neighbour = dir.join("backup.txt");
    std::fs::write(&neighbour, "keep me").unwrap();
    for name in ["backup.json", "backup.json"] {
        write_export(&dir.join(name), b"{}").unwrap();
    }
    assert_eq!(std::fs::read_to_string(&neighbour).unwrap(), "keep me");
    assert_eq!(
        std::fs::read_to_string(dir.join("backup.json")).unwrap(),
        "{}"
    );
    let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
    assert_eq!(left.len(), 2, "no temporary file stays behind");
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(windows)]
#[tokio::test]
async fn settings_that_cannot_be_saved_undo_the_bookmarks_and_their_passwords() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = std::env::temp_dir().join(format!("ftpeach-import-test-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let vault = Vault::new(dir.join("vault"));
    vault.setup("correct horse battery staple").await.unwrap();
    store
        .set_settings(
            serde_json::json!({"theme": "light"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .await
        .unwrap();
    let record = site("a", "a.test").as_object().unwrap().clone();
    let secrets = HashMap::from([(
        "a".to_owned(),
        ImportedSecret {
            scope: site_scope(&record),
            password: Some("p".to_owned().into()),
            key_passphrase: None,
        },
    )]);
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(dir.join("settings.json"))
        .unwrap();
    let failed = apply_import(
        store.clone(),
        vault.clone(),
        vec![record],
        secrets,
        Some(
            serde_json::json!({"theme": "dark"})
                .as_object()
                .unwrap()
                .clone(),
        ),
    )
    .await
    .err()
    .unwrap();
    drop(deny_replace);
    assert!(failed.not_restored.is_empty(), "{:?}", failed.not_restored);
    assert!(store.list_sites().await.unwrap().is_empty());
    assert_eq!(store.get_settings().await["theme"], "light");
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[test]
fn generated_import_files_never_stage_a_secret_or_an_entry_that_fails_its_checks() {
    let example = serde_json::json!({
        "exportedAt": "2026-10-15T00:00:00Z",
        "appVersion": "0.4.0",
        "settings": {"concurrency": 4, "proxyPort": 8080},
        "sites": [
            site("a", "a.test"),
            {"id": "f", "kind": "folder", "name": "Folder"},
            {"id": "l", "kind": "local", "name": "Here", "localPath": "C:\\Users"},
            {"id": "w", "kind": "site", "name": "Dav", "protocol": "webdav", "webdavUrl": "https://dav.test/x"},
        ],
    });
    const SECRETS: &[&str] = &[
        "password",
        "keyPassphrase",
        "enc",
        "plain",
        "keyEnc",
        "keyPlain",
        "proxyPassword",
        "proxyPasswordEnc",
        "proxyPasswordPlain",
    ];
    let keys: Vec<&str> = SECRETS
        .iter()
        .copied()
        .chain([
            "kind",
            "localPath",
            "webdavUrl",
            "protocol",
            "host",
            "port",
            "id",
            "parentId",
            "formatVersion",
            "secrets",
        ])
        .collect();
    let mut staged_count = 0;
    for value in crate::test_inputs::variants(&example, &keys, 0x1a90_7000, 3_000) {
        let Ok(file) = serde_json::from_value::<ImportDocument>(value) else {
            continue;
        };
        let Ok(staged) = stage(file, &options(), "main") else {
            continue;
        };
        staged_count += 1;
        for key in staged.settings.iter().flat_map(|settings| settings.keys()) {
            assert!(!SECRETS.contains(&key.as_str()), "settings.{key}");
        }
        for (index, site) in staged.sites.iter().enumerate() {
            assert!(
                site.keys().all(|key| !SECRETS.contains(&key.as_str())),
                "{site:?}"
            );
            assert_eq!(validate_import_site(site, index), Ok(()));
        }
    }
    // The edits must leave enough files whole for the checks above to mean something.
    assert!(staged_count > 300, "{staged_count}");
}

fn import_test_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ftpeach-import-read-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn an_import_file_is_refused_by_size_encoding_and_absence() {
    let dir = import_test_dir();
    let big = dir.join("big.json");
    std::fs::write(&big, vec![b' '; MAX_IMPORT_BYTES as usize + 1]).unwrap();
    let error = read_import_file(big.to_str().unwrap()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert!(
        error
            .details
            .unwrap()
            .contains(&format!("maximum is {MAX_IMPORT_BYTES}"))
    );

    let latin1 = dir.join("latin1.json");
    std::fs::write(&latin1, b"{\"name\":\"caf\xe9\"}").unwrap();
    let error = read_import_file(latin1.to_str().unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.details.unwrap().contains("Invalid UTF-8"));

    let missing = dir.join("missing.json");
    let error = read_import_file(missing.to_str().unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);

    let fine = dir.join("fine.json");
    std::fs::write(&fine, "{}").unwrap();
    assert_eq!(
        read_import_file(fine.to_str().unwrap()).await.unwrap(),
        "{}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn an_import_file_another_program_holds_is_named_as_in_use() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = import_test_dir();
    let held = dir.join("held.json");
    std::fs::write(&held, "{}").unwrap();
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&held)
        .unwrap();
    let error = read_import_file(held.to_str().unwrap()).await.unwrap_err();
    drop(holder);
    assert_eq!(
        error.code,
        ErrorCode::FileInUse,
        "a held import file is reported by its code"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn every_secret_field_is_stripped_on_export_and_refused_on_import() {
    let secret = || serde_json::Value::String("secret".into());
    let site = JsonMap::from_iter(
        SITE_INPUT
            .into_iter()
            .chain(SITE_SAVED)
            .map(|key| (key.to_string(), secret())),
    );
    let exported = strip_site_secrets(site);
    for key in SITE_INPUT.into_iter().chain(SITE_SAVED) {
        assert!(!exported.contains_key(key), "exported site field {key}");
        let record = JsonMap::from_iter([(key.to_string(), secret())]);
        let refused = validate_import_site(&record, 0).unwrap_err();
        assert!(refused.contains("secret fields"), "{key}: {refused}");
    }

    let settings = JsonMap::from_iter(proxy_secret_fields().map(|key| (key.to_string(), secret())));
    let exported = strip_settings_secrets(settings);
    for key in proxy_secret_fields() {
        assert!(!exported.contains_key(key), "exported setting {key}");
        let patch = JsonMap::from_iter([(key.to_string(), secret())]);
        let refused = crate::store::validate_settings(&patch, false).unwrap_err();
        assert!(refused.contains("secret fields"), "{key}: {refused}");
    }
}
