//! Compatibility goldens for saved sites and the settings a connect resolves.
//!
//! `test/fixtures/site-compat/cases.json` holds stored files and requests.
//! Every operation below runs on them through production code and the
//! outcome is compared with `current.json`. `v0.3.0.json` is the same run
//! recorded with the code of FTPeach 0.3.0; `differences.json` names every
//! place the current outcome is allowed to differ from it, and why.
//!
//! Secrets never appear in an outcome: a fixture secret is written as
//! `$secret:N`, a DPAPI blob as the secret it opens to (`$dpapi:N`).
//!
//! `FTPEACH_RECORD_SITE_GOLDENS=<file>` writes the outcome to that file
//! instead of comparing it.

use crate::application::session_service;
use crate::security::vault::{SecretUpdate, Vault};
use crate::store::{JsonMap, Store};
use base64::Engine;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const CASES: &str = include_str!("../../../test/fixtures/site-compat/cases.json");
const SECRETS: [&str; 5] = [
    "compat-secret-one",
    "compat-secret-two",
    "compat-proxy-three",
    "compat-direct-four",
    "compat-direct-five",
];
const MASTER_PASSWORD: &str = "compat master password";
const ENCRYPTED_FIELDS: [&str; 3] = ["enc", "keyEnc", "proxyPasswordEnc"];

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test/fixtures/site-compat")
        .join(name)
}

fn secret(index: &str) -> &'static str {
    SECRETS[index.parse::<usize>().unwrap() - 1]
}

/// Replaces `$secret:N` and `$dpapi:N` with the values they stand for.
fn expand(value: &Value) -> Value {
    match value {
        Value::String(text) => match text.split_once(':') {
            Some(("$secret", index)) => Value::String(secret(index).into()),
            Some(("$dpapi", "bad")) => Value::String("AAECAwQF".into()),
            Some(("$dpapi", index)) => Value::String(
                base64::engine::general_purpose::STANDARD
                    .encode(crate::security::dpapi::protect(secret(index).as_bytes()).unwrap()),
            ),
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), expand(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn secret_label(text: &str) -> String {
    match SECRETS.iter().position(|secret| *secret == text) {
        Some(index) => format!("$secret:{}", index + 1),
        None if text.is_empty() => "<empty>".into(),
        None => "<other secret>".into(),
    }
}

fn dpapi_label(text: &str) -> String {
    let opened = base64::engine::general_purpose::STANDARD
        .decode(text)
        .ok()
        .and_then(|bytes| crate::security::dpapi::unprotect(&bytes).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok());
    match opened {
        Some(plain) => secret_label(&plain).replace("$secret", "$dpapi"),
        None => "$dpapi:bad".into(),
    }
}

/// Writes every secret in `value` as its label.
fn labelled(value: &Value) -> Value {
    match value {
        Value::String(text) if SECRETS.contains(&text.as_str()) => {
            Value::String(secret_label(text))
        }
        Value::Array(items) => Value::Array(items.iter().map(labelled).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| match value {
                    Value::String(text) if ENCRYPTED_FIELDS.contains(&key.as_str()) => {
                        (key.clone(), Value::String(dpapi_label(text)))
                    }
                    _ => (key.clone(), labelled(value)),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn refused(error: &crate::ipc::CommandError) -> Value {
    json!({ "refused": {
        "code": error.code,
        "message": error.message,
        "details": error.details,
    }})
}

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(sites: Option<&Value>, local_paths: Option<&Value>) -> Self {
        let root =
            std::env::temp_dir().join(format!("ftpeach-site-compat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for (name, content) in [("sites.json", sites), ("local-paths.json", local_paths)] {
            if let Some(content) = content {
                std::fs::write(root.join(name), expand(content).to_string()).unwrap();
            }
        }
        Self { root }
    }

    fn store(&self) -> Store {
        Store::new_at(self.root.clone())
    }

    fn file(&self, name: &str) -> Value {
        std::fs::read_to_string(self.root.join(name))
            .ok()
            .map(|text| labelled(&serde_json::from_str(&text).unwrap()))
            .unwrap_or(Value::Null)
    }

    fn files(&self) -> Value {
        json!({ "sites": self.file("sites.json"), "localPaths": self.file("local-paths.json") })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn apply_settings(store: &Store, vault: &Vault, patch: &Value) {
    let patch = expand(patch).as_object().unwrap().clone();
    let saved = if vault.is_configured() {
        store.set_settings_with_vault(patch.clone(), vault).await
    } else {
        store.set_settings(patch.clone()).await
    };
    // Settings the store now refuses can still be in a file an older
    // version wrote.
    if saved.is_err() {
        std::fs::write(
            store.data_dir().join("settings.json"),
            Value::Object(patch).to_string(),
        )
        .unwrap();
    }
}

/// The protocol configuration a request resolves to, as the protocol layer
/// receives it, and which secrets it carries.
async fn resolved(store: &Store, vault: &Vault, request: &Value) -> Value {
    let request: crate::domain::ConnectionConfig = match serde_json::from_value(expand(request)) {
        Ok(request) => request,
        Err(error) => return json!({ "unreadable": error.to_string() }),
    };
    if let Err(error) = request.validate() {
        return refused(&error);
    }
    match session_service::resolve_connection_config(store, vault, request).await {
        Ok(config) => describe(&config),
        Err(error) => refused(&error),
    }
}

fn describe(config: &crate::protocol::config::ConnectionConfig) -> Value {
    use crate::protocol::config::ConnectionConfig;
    let (password, key_passphrase) = match config {
        ConnectionConfig::Ftp(config) => (&config.password, None),
        ConnectionConfig::Sftp(config) => (&config.password, Some(&config.key_passphrase)),
        ConnectionConfig::Webdav(config) => (&config.password, None),
    };
    let proxy_password = config.common().proxy.as_ref().map(|proxy| {
        proxy
            .password
            .as_ref()
            .map(|value| secret_label(value.expose()))
    });
    json!({
        "config": format!("{config:?}"),
        "protocol": config.protocol(),
        "server": config.server(),
        "logLabel": config.log_label(),
        "secrets": {
            "password": secret_label(password.expose()),
            "keyPassphrase": key_passphrase
                .map(|value| value.as_ref().map(|value| secret_label(value.expose()))),
            "proxyPassword": proxy_password,
        },
    })
}

fn saved_site_request(id: &str) -> Value {
    // What the renderer sends for a bookmark: the id, and the two settings it
    // applies to every connect. Its other fields are the pane's form, which
    // the backend ignores next to a `siteId`.
    json!({
        "siteId": id, "protocol": "ftp", "host": "ignored.example.test", "user": "ignored",
        "password": "", "timeout": 15000, "activeMode": true,
    })
}

fn site_ids(sites: &Value) -> Vec<String> {
    let entries = sites.get("data").unwrap_or(sites);
    entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| !matches!(entry["kind"].as_str(), Some("folder" | "local")))
        .map(|entry| entry["id"].as_str().unwrap().to_owned())
        .collect()
}

async fn store_case(case: &Value, settings: &Value) -> Value {
    let sites = case.get("sites");
    let local_paths = case.get("localPaths");
    let no_vault = |scratch: &Scratch| Vault::new(scratch.root.join("no-vault"));

    let scratch = Scratch::new(sites, local_paths);
    let before = scratch.files();
    let listed = scratch.store().list_sites().await;
    let list = json!({
        "sites": listed.map(|sites| labelled(&Value::from(sites.into_iter().map(Value::Object).collect::<Vec<_>>()))).map_err(|error| format!("{error:#}")),
        "warnings": scratch.store().storage_warnings(),
        "filesChanged": scratch.files() != before,
        "filesAfter": scratch.files(),
    });

    let mut connects = serde_json::Map::new();
    for id in site_ids(sites.unwrap()) {
        let scratch = Scratch::new(sites, local_paths);
        let store = scratch.store();
        let vault = no_vault(&scratch);
        apply_settings(&store, &vault, &settings["none"]).await;
        let before = scratch.file("sites.json");
        let outcome = resolved(&store, &vault, &saved_site_request(&id)).await;
        connects.insert(
            id,
            json!({
                "outcome": outcome,
                "sitesChanged": scratch.file("sites.json") != before,
                "sitesAfter": scratch.file("sites.json"),
            }),
        );
    }

    let mut saves = Vec::new();
    for save in case["saves"].as_array().unwrap() {
        let scratch = Scratch::new(sites, local_paths);
        let store = scratch.store();
        let payload = expand(&save["payload"]).as_object().unwrap().clone();
        let stored = match payload.get("id").and_then(Value::as_str) {
            Some(id) => store.saved_site_credentials(id).await,
            None => None,
        };
        let transfer =
            crate::security::credential_scope::site_save_transfer(stored.as_ref(), &payload);
        let outcome = store.save_site(payload).await;
        saves.push(json!({
            "note": save["note"],
            "transfer": transfer,
            "outcome": match outcome {
                Ok(saved) => json!({ "id": if save["payload"]["id"].is_null() { "<new>".to_owned() } else { saved.id }, "secretNotPersisted": saved.secret_not_persisted }),
                Err(error) => refused(&crate::ipc::CommandError::from_anyhow(&error)),
            },
            "filesAfter": without_new_ids(scratch.files()),
        }));
    }

    let mut scopes = serde_json::Map::new();
    let stored = expand(sites.unwrap());
    for entry in stored.get("data").unwrap_or(&stored).as_array().unwrap() {
        scopes.insert(
            entry["id"].as_str().unwrap().to_owned(),
            json!(crate::security::credential_scope::site_scope(
                entry.as_object().unwrap()
            )),
        );
    }

    json!({
        "list": list,
        "connect": connects,
        "saves": saves,
        "scopes": scopes,
        "import": import_case(case).await,
    })
}

/// A new bookmark gets a random id; the outcome names it `<new>`.
fn without_new_ids(mut files: Value) -> Value {
    if let Some(entries) = files["sites"]["data"].as_array_mut() {
        for entry in entries {
            let id = entry["id"].as_str().unwrap_or_default();
            if uuid::Uuid::parse_str(id).is_ok() {
                entry["id"] = json!("<new>");
            }
        }
    }
    files
}

/// Import checks each exported bookmark, then saves the valid ones into an
/// empty profile.
async fn import_case(case: &Value) -> Value {
    use crate::commands::app::settings_transfer::{
        import_sites, strip_site_secrets, validate_import_site,
    };
    let scratch = Scratch::new(case.get("sites"), case.get("localPaths"));
    let mut records: Vec<JsonMap> = scratch
        .store()
        .list_sites()
        .await
        .unwrap()
        .into_iter()
        .map(strip_site_secrets)
        .collect();
    records.extend(
        case["importExtra"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record.as_object().unwrap().clone()),
    );
    let verdicts: Vec<Value> = records
        .iter()
        .enumerate()
        .map(
            |(index, record)| match validate_import_site(record, index) {
                Ok(()) => json!("accepted"),
                Err(issue) => json!({ "refused": issue }),
            },
        )
        .collect();
    let accepted: Vec<Value> = records
        .into_iter()
        .zip(&verdicts)
        .filter(|(_, verdict)| verdict.as_str() == Some("accepted"))
        .map(|(record, _)| Value::Object(record))
        .collect();
    let target = Scratch::new(None, None);
    let outcome = import_sites(&target.store(), accepted, &[]).await;
    json!({
        "verdicts": verdicts,
        "outcome": outcome.map(|done| json!({"added": done.added, "skipped": done.skipped})).map_err(|error| format!("{error:#}")),
        "filesAfter": renumbered(target.files()),
    })
}

/// Imported entries get new random ids; the outcome numbers them in order.
fn renumbered(files: Value) -> Value {
    let text = files.to_string();
    let mut ids: Vec<String> = Vec::new();
    for part in text.split('"') {
        if uuid::Uuid::parse_str(part).is_ok() && !ids.iter().any(|id| id == part) {
            ids.push(part.to_owned());
        }
    }
    let mut text = text;
    for (index, id) in ids.iter().enumerate() {
        text = text.replace(id, &format!("<new {}>", index + 1));
    }
    serde_json::from_str(&text).unwrap()
}

async fn vault_case(case: &Value, settings: &Value) -> Value {
    let scratch = Scratch::new(case.get("sites"), None);
    let store = scratch.store();
    let vault = Vault::new(scratch.root.clone());
    vault.setup(MASTER_PASSWORD).await.unwrap();
    for entry in case["secrets"].as_array().unwrap() {
        let value = expand(&entry["value"]);
        vault
            .apply_secret_updates(&[SecretUpdate::Set {
                site_id: entry["siteId"].as_str().unwrap(),
                field: entry["field"].as_str().unwrap(),
                value: value.as_str().unwrap().as_bytes(),
            }])
            .await
            .unwrap();
    }
    let mut outcome = serde_json::Map::new();
    for name in ["none", "socks5-proxy"] {
        apply_settings(&store, &vault, &settings[name]).await;
        let mut connects = serde_json::Map::new();
        for id in site_ids(&case["sites"]) {
            connects.insert(
                id.clone(),
                resolved(&store, &vault, &saved_site_request(&id)).await,
            );
        }
        outcome.insert(name.into(), Value::Object(connects));
    }
    let listed = store.list_sites().await.unwrap();
    outcome.insert(
        "list".into(),
        labelled(&Value::from(
            listed.into_iter().map(Value::Object).collect::<Vec<_>>(),
        )),
    );
    outcome.insert("filesAfter".into(), scratch.files()["sites"].clone());
    vault.lock().await;
    Value::Object(outcome)
}

async fn direct_requests(cases: &Value) -> Value {
    let mut outcome = serde_json::Map::new();
    for entry in cases["directRequests"].as_array().unwrap() {
        let mut by_settings = serde_json::Map::new();
        for (name, patch) in cases["settings"].as_object().unwrap() {
            let scratch = Scratch::new(None, None);
            let store = scratch.store();
            let vault = Vault::new(scratch.root.join("no-vault"));
            apply_settings(&store, &vault, patch).await;
            by_settings.insert(
                name.clone(),
                resolved(&store, &vault, &entry["request"]).await,
            );
        }
        outcome.insert(
            entry["name"].as_str().unwrap().to_owned(),
            Value::Object(by_settings),
        );
    }
    Value::Object(outcome)
}

async fn outcome() -> Value {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let mut stores = serde_json::Map::new();
    for case in cases["stores"].as_array().unwrap() {
        stores.insert(
            case["name"].as_str().unwrap().to_owned(),
            store_case(case, &cases["settings"]).await,
        );
    }
    json!({
        "stores": stores,
        "vault": vault_case(&cases["vault"], &cases["settings"]).await,
        "direct": direct_requests(&cases).await,
    })
}

/// Every JSON pointer at which `a` and `b` differ.
fn differences(a: &Value, b: &Value, at: &str, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                differences(
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                    &format!("{at}/{}", key.replace('~', "~0").replace('/', "~1")),
                    out,
                );
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                differences(a, b, &format!("{at}/{index}"), out);
            }
        }
        _ if a != b => out.push(at.to_owned()),
        _ => {}
    }
}

fn read_fixture(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture(name)).unwrap()).unwrap()
}

#[cfg(windows)]
#[tokio::test]
async fn saved_sites_and_connections_match_their_goldens() {
    let actual = outcome().await;
    if let Some(path) = std::env::var_os("FTPEACH_RECORD_SITE_GOLDENS") {
        std::fs::write(path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
        return;
    }
    let mut changed = Vec::new();
    differences(&read_fixture("current.json"), &actual, "", &mut changed);
    assert!(
        changed.is_empty(),
        "outcome differs from current.json at:\n{}",
        changed.join("\n")
    );

    let mut from_0_3_0 = Vec::new();
    differences(&read_fixture("v0.3.0.json"), &actual, "", &mut from_0_3_0);
    let explained = read_fixture("differences.json");
    let explained: Vec<&str> = explained
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let unexplained: Vec<&String> = from_0_3_0
        .iter()
        .filter(|pointer| !explained.contains(&pointer.as_str()))
        .collect();
    let stale: Vec<&&str> = explained
        .iter()
        .filter(|pointer| !from_0_3_0.iter().any(|changed| changed == *pointer))
        .collect();
    assert!(
        unexplained.is_empty() && stale.is_empty(),
        "differences from 0.3.0 without a reason in differences.json:\n{unexplained:#?}\nreasons for differences that no longer exist:\n{stale:#?}"
    );
}
