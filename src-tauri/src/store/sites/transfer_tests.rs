use super::*;
use serde_json::json;

const MASTER: &str = "correct horse battery staple";

/// A store, with the vault set up when `vault` is true.
struct Profile {
    root: PathBuf,
    store: Store,
    vault: Vault,
}

impl Profile {
    async fn new(vault: bool) -> Self {
        let root = std::env::temp_dir().join(format!("ftpeach-transfer-{}", uuid::Uuid::new_v4()));
        let profile = Self {
            store: Store::new_at(root.clone()),
            vault: Vault::new(root.join("vault")),
            root,
        };
        if vault {
            profile.vault.setup(MASTER).await.unwrap();
        }
        profile
    }

    async fn save(&self, site: Value) -> String {
        let site = site.as_object().unwrap().clone();
        self.store
            .save_site_with_vault(site, None, &self.vault)
            .await
            .unwrap()
            .id
    }

    async fn sites(&self) -> Vec<JsonMap> {
        self.store.list_sites().await.unwrap()
    }

    async fn id_of(&self, name: &str) -> String {
        self.sites()
            .await
            .into_iter()
            .find(|site| site["name"] == name)
            .and_then(|site| site["id"].as_str().map(str::to_owned))
            .unwrap()
    }

    async fn password(&self, id: &str) -> String {
        self.store
            .saved_server(id, &self.vault)
            .await
            .unwrap()
            .1
            .password
            .expose()
            .to_owned()
    }

    async fn import(
        &self,
        sites: &[JsonMap],
        secrets: HashMap<String, ImportedSecret>,
    ) -> SitesImported {
        match self.store.import_sites(&self.vault, sites, secrets).await {
            Ok((outcome, _kept)) => outcome,
            Err(failed) => panic!("{:#}", failed.error),
        }
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn server(name: &str, host: &str) -> Value {
    json!({"kind": "site", "name": name, "protocol": "ftp", "host": host, "user": "bob"})
}

fn secret(site: &JsonMap, password: &str) -> ImportedSecret {
    ImportedSecret {
        scope: site_scope(site),
        password: Some(SensitiveString::from(password.to_owned())),
        key_passphrase: None,
    }
}

/// A file's bookmark for `host`, under the id `old`, and its saved password.
fn file_with_secret(host: &str, password: &str) -> (JsonMap, HashMap<String, ImportedSecret>) {
    let site = server("Work", host).as_object().unwrap().clone();
    let secrets = HashMap::from([("old".to_owned(), secret(&site, password))]);
    let mut file = site;
    file.insert("id".into(), json!("old"));
    (file, secrets)
}

/// What an export of `source` carries: its bookmarks as listed, and each
/// saved secret by the id the bookmark has there.
async fn exported(source: &Profile) -> (Vec<JsonMap>, HashMap<String, ImportedSecret>) {
    let sites = source.sites().await;
    let mut readable = source
        .store
        .secrets_for_export(&source.vault)
        .await
        .unwrap();
    assert!(readable.unreadable.is_empty());
    let secrets = sites
        .iter()
        .filter_map(|site| {
            let id = site["id"].as_str()?;
            let saved = readable.by_id.remove(id)?;
            Some((
                id.to_owned(),
                ImportedSecret {
                    scope: site_scope(site),
                    password: saved.password.map(|value| value.to_string().into()),
                    key_passphrase: saved.key_passphrase.map(|value| value.to_string().into()),
                },
            ))
        })
        .collect();
    (sites, secrets)
}

#[tokio::test]
async fn passwords_carry_between_every_kind_of_protection() {
    for (from_vault, to_vault) in [(false, false), (false, true), (true, false), (true, true)] {
        let source = Profile::new(from_vault).await;
        let mut site = server("Work", "a.example").as_object().unwrap().clone();
        site.insert("password".into(), json!("s3cret"));
        site.insert("protocol".into(), json!("sftp"));
        site.insert("keyPassphrase".into(), json!("key words"));
        source.save(Value::Object(site)).await;

        let target = Profile::new(to_vault).await;
        let (sites, secrets) = exported(&source).await;
        let outcome = target.import(&sites, secrets).await;
        assert_eq!((outcome.added, outcome.secrets_saved), (1, 2));

        let id = target.id_of("Work").await;
        let (_, credentials) = target.store.saved_server(&id, &target.vault).await.unwrap();
        let case = format!("vault {from_vault} -> {to_vault}");
        assert_eq!(credentials.password.expose(), "s3cret", "{case}");
        assert_eq!(
            credentials.key_passphrase.as_ref().unwrap().expose(),
            "key words",
            "{case}"
        );
        let listed = target.sites().await;
        assert_eq!(listed[0]["hasPassword"], true, "{case}");
        assert_eq!(listed[0]["hasKeyPassphrase"], true, "{case}");
    }
}

#[tokio::test]
async fn a_second_import_fills_what_the_first_left_out_and_overwrites_nothing() {
    let source = Profile::new(false).await;
    let mut site = server("Work", "a.example").as_object().unwrap().clone();
    site.insert("password".into(), json!("from the file"));
    source.save(Value::Object(site)).await;
    let (sites, _) = exported(&source).await;

    for vault in [false, true] {
        let target = Profile::new(vault).await;
        let without = target.import(&sites, HashMap::new()).await;
        assert_eq!((without.added, without.secrets_saved), (1, 0));
        let id = target.id_of("Work").await;
        assert_eq!(target.password(&id).await, "");

        let (_, secrets) = exported(&source).await;
        let with = target.import(&sites, secrets).await;
        assert_eq!((with.added, with.skipped, with.secrets_saved), (0, 1, 1));
        assert_eq!(target.password(&id).await, "from the file");
        assert_eq!(target.sites().await.len(), 1);

        // Changed here since; the file's password does not come back.
        let mut edited = target.sites().await[0].clone();
        edited.insert("password".into(), json!("changed here"));
        target
            .store
            .save_site_with_vault(edited, None, &target.vault)
            .await
            .unwrap();
        let (_, secrets) = exported(&source).await;
        let again = target.import(&sites, secrets).await;
        assert_eq!((again.added, again.secrets_saved), (0, 0));
        assert_eq!(target.password(&id).await, "changed here");
    }
}

#[tokio::test]
async fn a_vault_secret_without_its_flag_gets_the_flag_back_not_a_new_value() {
    let target = Profile::new(true).await;
    let id = target.save(server("Work", "a.example")).await;
    target
        .vault
        .apply_secret_updates(&[SecretUpdate::Set {
            site_id: &id,
            field: "password",
            value: b"already here",
        }])
        .await
        .unwrap();
    assert_eq!(target.sites().await[0]["hasPassword"], false);

    let (file, secrets) = file_with_secret("a.example", "from the file");
    let outcome = target.import(&[file], secrets).await;
    assert_eq!((outcome.secrets_saved, outcome.flags_restored), (0, 1));
    assert_eq!(target.sites().await[0]["hasPassword"], true);
    assert_eq!(target.password(&id).await, "already here");
}

#[tokio::test]
async fn a_duplicate_gets_its_secret_only_from_one_exact_recipient() {
    let target = Profile::new(false).await;
    // Host case makes no other recipient; two bookmarks for one do not choose.
    target.save(server("Upper", "A.example")).await;
    target.save(server("Twin 1", "b.example")).await;
    target.save(server("Twin 2", "b.example")).await;

    let mut file = Vec::new();
    let mut secrets = HashMap::new();
    for (id, host) in [("upper", "a.example"), ("twin", "b.example")] {
        let mut site = server(id, host).as_object().unwrap().clone();
        site.insert("id".into(), json!(id));
        secrets.insert(id.to_owned(), secret(&site, "p"));
        file.push(site);
    }
    let outcome = target.import(&file, secrets).await;
    assert_eq!(outcome.skipped, 2);
    assert_eq!(outcome.secrets_saved, 1);
    // Two bookmarks here for b.example: neither is chosen.
    assert_eq!(outcome.unmatched, vec!["twin".to_owned()]);
    assert_eq!(target.password(&target.id_of("Upper").await).await, "p");
    for twin in ["Twin 1", "Twin 2"] {
        assert_eq!(target.password(&target.id_of(twin).await).await, "");
    }
}

#[tokio::test]
async fn a_bookmark_sent_elsewhere_than_its_secret_leaves_the_secret_behind() {
    let target = Profile::new(true).await;
    let saved_for = server("Work", "a.example").as_object().unwrap().clone();
    let mut file = server("Work", "evil.example").as_object().unwrap().clone();
    file.insert("id".into(), json!("old"));
    let secrets = HashMap::from([("old".to_owned(), secret(&saved_for, "p"))]);
    let outcome = target.import(&[file], secrets).await;
    assert_eq!(outcome.added, 1);
    assert_eq!(outcome.secrets_saved, 0);
    assert_eq!(outcome.scope_mismatches, vec!["Work".to_owned()]);
    assert_eq!(target.password(&target.id_of("Work").await).await, "");
}

#[tokio::test]
async fn secrets_wait_for_a_locked_vault_before_anything_is_written() {
    let target = Profile::new(true).await;
    target.vault.lock().await;
    let (site, secrets) = file_with_secret("a.example", "p");
    let failed = target
        .store
        .import_sites(&target.vault, &[site], secrets)
        .await
        .err()
        .unwrap();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&failed.error).code,
        ErrorCode::VaultLocked
    );
    assert!(target.sites().await.is_empty());
}

#[cfg(windows)]
#[tokio::test]
async fn a_bookmark_file_that_cannot_be_written_takes_the_vault_secrets_back() {
    use std::os::windows::fs::OpenOptionsExt;
    let target = Profile::new(true).await;
    let id = target.save(server("Work", "a.example")).await;
    let (file, secrets) = file_with_secret("a.example", "p");

    // Readable, so the import starts, but not replaceable.
    let deny_replace = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(target.root.join("sites.json"))
        .unwrap();
    let failed = target
        .store
        .import_sites(&target.vault, &[file], secrets)
        .await
        .err()
        .unwrap();
    drop(deny_replace);
    assert!(failed.not_restored.is_empty(), "{:?}", failed.not_restored);
    assert!(
        target
            .vault
            .get_secret(&id, "password")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(target.sites().await[0]["hasPassword"], false);
}

#[tokio::test]
async fn an_undone_import_names_what_it_could_not_undo_and_restores_the_rest() {
    let target = Profile::new(true).await;
    let (site, secrets) = file_with_secret("a.example", "p");
    let (_, import) = target
        .store
        .import_sites(&target.vault, &[site], secrets)
        .await
        .ok()
        .unwrap();
    target.vault.lock().await;
    let not_restored = import.rollback().await;
    assert_eq!(not_restored.len(), 1, "{not_restored:?}");
    assert!(not_restored[0].contains("vault"));
    assert!(target.sites().await.is_empty());
}

#[tokio::test]
async fn a_change_made_during_an_import_survives_its_undo() {
    let target = Profile::new(false).await;
    let site = server("Work", "a.example").as_object().unwrap().clone();
    let (_, import) = target
        .store
        .import_sites(&target.vault, &[site], HashMap::new())
        .await
        .ok()
        .unwrap();
    let saving = tokio::spawn({
        let store = target.store.clone();
        async move {
            store
                .save_folder(
                    json!({"name": "Made meanwhile"})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!saving.is_finished(), "the save waits for the import");
    assert!(import.rollback().await.is_empty());
    saving.await.unwrap().unwrap();
    let names: Vec<Value> = target
        .sites()
        .await
        .into_iter()
        .map(|site| site["name"].clone())
        .collect();
    assert_eq!(names, vec![json!("Made meanwhile")]);
}
