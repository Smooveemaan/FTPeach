use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::store::{JsonMap, Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettingsOptions {
    include_settings: bool,
    include_bookmarks: bool,
    include_local_paths: bool,
}

/// Mirrors `store::sites::is_local_scope_entry` — that module is private to
/// `store`, so this is a small local copy rather than a shared export.
fn is_local_paths_entry(site: &JsonMap) -> bool {
    match site.get("kind").and_then(Value::as_str) {
        Some("local") => true,
        Some("folder") => site.get("managerScope").and_then(Value::as_str) == Some("localPaths"),
        _ => false,
    }
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum ExportResult {
    Ok { ok: bool, path: String },
    Canceled { ok: bool, canceled: bool },
    Err { ok: bool, error: CommandError },
}

fn strip_settings_secrets(mut settings: JsonMap) -> JsonMap {
    for key in [
        "proxyPassword",
        "proxyPasswordEnc",
        "proxyPasswordPlain",
        "removeProxyPassword",
    ] {
        settings.remove(key);
    }
    settings
}

fn strip_site_secrets(mut site: JsonMap) -> JsonMap {
    for key in [
        "password",
        "keyPassphrase",
        "enc",
        "plain",
        "keyEnc",
        "keyPlain",
        "removePassword",
        "removeKeyPassphrase",
    ] {
        site.remove(key);
    }
    site.insert("hasPassword".into(), serde_json::Value::Bool(false));
    site.insert("hasKeyPassphrase".into(), serde_json::Value::Bool(false));
    site
}

#[tauri::command]
pub async fn app_export_settings(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    app: AppHandle,
    store: State<'_, Store>,
    options: ExportSettingsOptions,
) -> CommandResult<ExportResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "app_export_settings",
        "native-dialog",
    )?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export FTPeach settings")
        .set_file_name("ftpeach-settings.json")
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(ExportResult::Canceled {
            ok: false,
            canceled: true,
        });
    };

    let mut payload = JsonMap::new();
    payload.insert(
        "exportedAt".into(),
        serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
    );
    payload.insert(
        "appVersion".into(),
        serde_json::Value::String(app.package_info().version.to_string()),
    );
    if options.include_settings {
        payload.insert(
            "settings".into(),
            serde_json::Value::Object(strip_settings_secrets(store.get_settings().await)),
        );
    }
    if options.include_bookmarks || options.include_local_paths {
        let sites = store.list_sites().await.unwrap_or_default();
        let stripped: Vec<serde_json::Value> = sites
            .into_iter()
            .filter(|site| {
                if is_local_paths_entry(site) {
                    options.include_local_paths
                } else {
                    options.include_bookmarks
                }
            })
            .map(|site| serde_json::Value::Object(strip_site_secrets(site)))
            .collect();
        payload.insert("sites".into(), serde_json::Value::Array(stripped));
    }

    let path_str = path.to_string();
    let body = serde_json::to_string_pretty(&payload).unwrap_or_default();
    match tokio::fs::write(&path_str, body).await {
        Ok(()) => Ok(ExportResult::Ok {
            ok: true,
            path: path_str,
        }),
        Err(e) => Ok(ExportResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&anyhow::anyhow!(e.to_string())),
        }),
    }
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum ImportResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        ok: bool,
        settings: Option<JsonMap>,
        sites_added: usize,
        sites_skipped: usize,
    },
    Canceled {
        ok: bool,
        canceled: bool,
    },
    Err {
        ok: bool,
        error: CommandError,
        issues: Vec<String>,
    },
}

const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMPORTED_SITES: usize = 2_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportDocument {
    #[serde(default)]
    exported_at: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    settings: Option<JsonMap>,
    #[serde(default)]
    sites: Option<Vec<serde_json::Value>>,
}

fn validate_import_settings(patch: &JsonMap) -> Result<(), String> {
    crate::store::validate_settings(patch, false)
}

fn validate_import_site(record: &JsonMap, index: usize) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "id",
        "kind",
        "name",
        "icon",
        "color",
        "protocol",
        "host",
        "port",
        "user",
        "webdavUrl",
        "secure",
        "allowInvalidCert",
        "remotePath",
        "parentId",
        "useKeyAuth",
        "keyPath",
        "caCertPath",
        "localPath",
        "managerScope",
        // strip_site_secrets sets these on export; import_sites recomputes them.
        "hasPassword",
        "hasKeyPassphrase",
    ];
    const SECRET: &[&str] = &[
        "password",
        "keyPassphrase",
        "enc",
        "plain",
        "keyEnc",
        "keyPlain",
        "removePassword",
        "removeKeyPassphrase",
    ];
    for key in record.keys() {
        if SECRET.contains(&key.as_str()) {
            return Err(format!(
                "sites[{index}].{key}: secret fields cannot be imported"
            ));
        }
        if !ALLOWED.contains(&key.as_str()) {
            return Err(format!("sites[{index}].{key}: unknown field"));
        }
    }
    if record.get("kind").and_then(serde_json::Value::as_str) == Some("folder") {
        let name = record
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if name.trim().is_empty() || name.len() > 4096 {
            return Err(format!("sites[{index}].name: invalid folder name"));
        }
        return Ok(());
    }
    if record.get("kind").and_then(serde_json::Value::as_str) == Some("local") {
        let path = record
            .get("localPath")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !std::path::Path::new(path).is_absolute() {
            return Err(format!("sites[{index}].localPath: path must be absolute"));
        }
    }
    if record.get("protocol").and_then(serde_json::Value::as_str) == Some("webdav") {
        let url = record
            .get("webdavUrl")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        match reqwest::Url::parse(url) {
            Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => {}
            _ => {
                return Err(format!(
                    "sites[{index}].webdavUrl: expected an absolute HTTP(S) URL"
                ));
            }
        }
    }
    crate::store::validate_site_input(record).map_err(|error| format!("sites[{index}]: {error:#}"))
}

struct ImportSitesOutcome {
    pub added: usize,
    pub skipped: usize,
}

fn normalize_identity_part(value: &str) -> String {
    value.trim().to_lowercase()
}

/// "Same folder" key: name + `managerScope` (folders are never nested —
/// see [`Store::save_folder`]).
fn folder_identity_key(record: &JsonMap) -> String {
    let scope = record
        .get("managerScope")
        .and_then(Value::as_str)
        .filter(|s| *s == "localPaths")
        .unwrap_or("bookmarks");
    let name = record.get("name").and_then(Value::as_str).unwrap_or("");
    format!("folder|{scope}|{}", normalize_identity_part(name))
}

/// Mirrors `connectionIdentity` in `src/features/sites/siteManagerModel.ts`.
fn site_identity_key(record: &JsonMap) -> String {
    if record.get("kind").and_then(Value::as_str) == Some("local") {
        let path = record
            .get("localPath")
            .and_then(Value::as_str)
            .unwrap_or("");
        return format!("local|{}", normalize_identity_part(path));
    }
    let protocol = record.get("protocol").and_then(Value::as_str).unwrap_or("");
    let address = if protocol == "webdav" {
        record
            .get("webdavUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
    } else {
        record.get("host").and_then(Value::as_str).unwrap_or("")
    };
    let port = match record.get("port").and_then(Value::as_i64) {
        Some(port) if port != 0 => port.to_string(),
        _ => String::new(),
    };
    let user = record.get("user").and_then(Value::as_str).unwrap_or("");
    format!(
        "{protocol}|{}|{port}|{}",
        normalize_identity_part(address),
        normalize_identity_part(user)
    )
}

async fn import_sites(
    store: &Store,
    sites: Vec<serde_json::Value>,
    existing: &[JsonMap],
) -> anyhow::Result<ImportSitesOutcome> {
    let mut added = 0usize;
    let mut skipped = 0usize;
    // old id -> (new id, is a localPaths-scope folder) — the scope gates
    // reparenting below (a folder never holds both kinds, see `save_folder`).
    let mut folder_ids: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();

    let mut known_folder_ids: std::collections::HashMap<String, String> = existing
        .iter()
        .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("folder"))
        .filter_map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (folder_identity_key(entry), id.to_string()))
        })
        .collect();
    let mut known_site_keys: std::collections::HashSet<String> = existing
        .iter()
        .filter(|entry| entry.get("kind").and_then(Value::as_str) != Some("folder"))
        .map(site_identity_key)
        .collect();

    for site in &sites {
        let serde_json::Value::Object(record) = site else {
            anyhow::bail!("site must be an object")
        };
        if record.get("kind").and_then(serde_json::Value::as_str) != Some("folder") {
            continue;
        }
        let old_id = record
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let key = folder_identity_key(record);
        let is_local_paths =
            record.get("managerScope").and_then(Value::as_str) == Some("localPaths");
        if let Some(existing_id) = known_folder_ids.get(&key) {
            if let Some(old_id) = old_id {
                folder_ids.insert(old_id, (existing_id.clone(), is_local_paths));
            }
            skipped += 1;
            continue;
        }
        let mut folder = record.clone();
        folder.remove("id");
        let new_id = store.save_folder(folder).await?;
        known_folder_ids.insert(key, new_id.clone());
        if let Some(old_id) = old_id {
            folder_ids.insert(old_id, (new_id, is_local_paths));
        }
        added += 1;
    }
    for site in sites {
        if let serde_json::Value::Object(mut record) = site {
            if record.get("kind").and_then(serde_json::Value::as_str) == Some("folder") {
                continue;
            }
            let key = site_identity_key(&record);
            if known_site_keys.contains(&key) {
                skipped += 1;
                continue;
            }
            record.remove("id");
            record = strip_site_secrets(record);
            let is_local = record.get("kind").and_then(Value::as_str) == Some("local");
            // A legacy export's folder could mix scopes; drop a mismatched
            // parent to root instead of failing the import.
            let resolved_parent = record
                .get("parentId")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| folder_ids.get(id))
                .filter(|(_, folder_is_local_paths)| *folder_is_local_paths == is_local)
                .map(|(new_id, _)| new_id.clone());
            record.insert(
                "parentId".into(),
                resolved_parent
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null),
            );
            store.save_site(record).await?;
            known_site_keys.insert(key);
            added += 1;
        } else {
            anyhow::bail!("site must be an object");
        }
    }
    Ok(ImportSitesOutcome { added, skipped })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettingsOptions {
    include_settings: bool,
    include_bookmarks: bool,
    include_local_paths: bool,
}

#[tauri::command]
pub async fn app_import_settings(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    app: AppHandle,
    store: State<'_, Store>,
    options: ImportSettingsOptions,
) -> CommandResult<ImportResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "app_import_settings",
        "native-dialog",
    )?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import FTPeach settings")
        .add_filter("JSON", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(ImportResult::Canceled {
            ok: false,
            canceled: true,
        });
    };

    let path_string = path.to_string();
    let metadata = match tokio::fs::metadata(&path_string).await {
        Ok(metadata) => metadata,
        Err(error) => {
            return Ok(ImportResult::Err {
                ok: false,
                error: CommandError::from(error),
                issues: vec!["Cannot inspect the selected import file".into()],
            });
        }
    };
    if metadata.len() > MAX_IMPORT_BYTES {
        return Ok(ImportResult::Err {
            ok: false,
            error: CommandError::new(
                ErrorCode::ResourceLimit,
                "Import file exceeds the 4 MiB limit",
            ),
            issues: vec![format!(
                "File size is {} bytes; maximum is {MAX_IMPORT_BYTES}",
                metadata.len()
            )],
        });
    }
    use tokio::io::AsyncReadExt;
    let raw = match tokio::fs::File::open(&path_string).await {
        Ok(file) => {
            let mut bytes = Vec::new();
            if let Err(error) = file
                .take(MAX_IMPORT_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
            {
                return Ok(ImportResult::Err {
                    ok: false,
                    error: CommandError::from(error),
                    issues: vec!["Cannot read the selected import file".into()],
                });
            }
            if bytes.len() as u64 > MAX_IMPORT_BYTES {
                return Ok(ImportResult::Err {
                    ok: false,
                    error: CommandError::new(
                        ErrorCode::ResourceLimit,
                        "Import file exceeds the 4 MiB limit",
                    ),
                    issues: vec!["File grew beyond the size limit while being read".into()],
                });
            }
            match String::from_utf8(bytes) {
                Ok(raw) => raw,
                Err(_) => {
                    return Ok(ImportResult::Err {
                        ok: false,
                        error: CommandError::new(
                            ErrorCode::InvalidInput,
                            "Import file must be UTF-8 JSON",
                        ),
                        issues: vec!["Invalid UTF-8".into()],
                    });
                }
            }
        }
        Err(e) => {
            return Ok(ImportResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&anyhow::anyhow!(e.to_string())),
                issues: vec!["Cannot read the selected import file".into()],
            });
        }
    };
    let mut data: ImportDocument = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            return Ok(ImportResult::Err {
                ok: false,
                error: CommandError::new(
                    ErrorCode::InvalidInput,
                    "Import file does not match the supported schema",
                ),
                issues: vec![e.to_string()],
            });
        }
    };

    // Options gate what's applied, independent of what the file contains —
    // mirrors the checkbox filter in app_export_settings.
    if !options.include_settings {
        data.settings = None;
    }
    if let Some(sites) = data.sites.as_mut() {
        sites.retain(|site| match site.as_object() {
            Some(record) if is_local_paths_entry(record) => options.include_local_paths,
            Some(_) => options.include_bookmarks,
            None => true, // malformed entry — let validation below report it
        });
    }

    let _ = (&data.exported_at, &data.app_version);
    let mut issues = Vec::new();
    if let Some(settings) = data.settings.as_ref()
        && let Err(issue) = validate_import_settings(settings)
    {
        issues.push(issue);
    }
    if let Some(sites) = data.sites.as_ref() {
        if sites.len() > MAX_IMPORTED_SITES {
            issues.push(format!("sites: more than {MAX_IMPORTED_SITES} entries"));
        }
        for (index, site) in sites.iter().enumerate() {
            match site.as_object() {
                Some(record) => {
                    if let Err(issue) = validate_import_site(record, index) {
                        issues.push(issue);
                    }
                }
                None => issues.push(format!("sites[{index}]: expected an object")),
            }
        }
    }
    if !issues.is_empty() {
        return Ok(ImportResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, "Import validation failed"),
            issues,
        });
    }

    let previous_settings = store.get_settings().await;
    let previous_sites = store.snapshot_sites_for_import().await?;

    let mut settings_out = None;
    if let Some(patch) = data.settings {
        let had_speed_limit = patch.contains_key("transferSpeedLimitKBps");
        let had_prevent_sleep = patch.contains_key("preventSleepDuringTransfers");
        match store.set_settings(patch).await {
            Ok(next) => {
                if had_speed_limit {
                    crate::runtime::settings_apply::apply_speed_limit(&next);
                }
                if had_prevent_sleep {
                    crate::runtime::settings_apply::apply_prevent_sleep(&next);
                }
                settings_out = Some(next);
            }
            Err(error) => {
                return Ok(ImportResult::Err {
                    ok: false,
                    error: CommandError::from_anyhow(&error),
                    issues: vec!["Settings could not be saved".into()],
                });
            }
        }
    }

    let mut sites_added = 0usize;
    let mut sites_skipped = 0usize;
    if let Some(sites) = data.sites {
        match import_sites(&store, sites, &previous_sites).await {
            Ok(outcome) => {
                sites_added = outcome.added;
                sites_skipped = outcome.skipped;
            }
            Err(error) => {
                let mut issues =
                    vec!["Import failed; restoring the previous settings and sites".into()];
                match store.replace_settings_for_import(&previous_settings).await {
                    Ok(()) => {
                        crate::runtime::settings_apply::apply_speed_limit(&previous_settings);
                        crate::runtime::settings_apply::apply_prevent_sleep(&previous_settings);
                    }
                    Err(restore) => issues.push(format!("Settings rollback failed: {restore:#}")),
                }
                if let Err(restore) = store.replace_sites_for_import(&previous_sites).await {
                    issues.push(format!("Sites rollback failed: {restore:#}"));
                }
                return Ok(ImportResult::Err {
                    ok: false,
                    error: CommandError::from_anyhow(&error),
                    issues,
                });
            }
        }
    }

    Ok(ImportResult::Ok {
        ok: true,
        settings: settings_out,
        sites_added,
        sites_skipped,
    })
}

#[cfg(test)]
#[path = "app_settings_transfer_tests.rs"]
mod tests;
