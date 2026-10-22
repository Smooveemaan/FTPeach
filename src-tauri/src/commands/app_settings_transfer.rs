use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::security::credential_scope::site_scope;
use crate::security::export_secrets::{self, SealEntry, SecretsBlock};
use crate::security::vault::Vault;
use crate::store::{
    ImportFailed, ImportedSecret, JsonMap, SITE_INPUT, SITE_SAVED, SitesImported, Store,
    is_local_scope_entry, proxy_secret_fields,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettingsOptions {
    include_settings: bool,
    include_bookmarks: bool,
    include_local_paths: bool,
    /// Seal the bookmarks' saved passwords into the file.
    #[serde(default)]
    include_secrets: bool,
    /// Leave out the passwords of bookmarks this computer cannot open,
    /// instead of refusing the export.
    #[serde(default)]
    skip_unreadable: bool,
}

/// A server bookmark: what can have saved secrets.
fn is_server_entry(site: &JsonMap) -> bool {
    !matches!(
        site.get("kind").and_then(Value::as_str),
        Some("folder" | "local")
    )
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum ExportResult {
    Ok {
        ok: bool,
        path: String,
        /// Passwords and passphrases sealed into the file.
        secrets: usize,
    },
    Canceled {
        ok: bool,
        canceled: bool,
    },
}

fn strip_settings_secrets(mut settings: JsonMap) -> JsonMap {
    for key in proxy_secret_fields() {
        settings.remove(key);
    }
    settings
}

pub(crate) fn strip_site_secrets(mut site: JsonMap) -> JsonMap {
    for key in SITE_INPUT.into_iter().chain(SITE_SAVED) {
        site.remove(key);
    }
    site.insert("hasPassword".into(), serde_json::Value::Bool(false));
    site.insert("hasKeyPassphrase".into(), serde_json::Value::Bool(false));
    site
}

/// The grant an export asks for: one with the saved passwords is confirmed
/// on its own, with the master password when the vault is set up.
pub(crate) fn export_target(include_secrets: bool) -> &'static str {
    if include_secrets {
        "secrets"
    } else {
        "native-dialog"
    }
}

/// Seals the saved secrets of `sites` (the exported bookmarks) with
/// `password`. A secret this computer cannot open refuses the export unless
/// `skip_unreadable`, naming the bookmarks.
async fn seal_secrets(
    store: &Store,
    vault: &Vault,
    sites: &[serde_json::Value],
    password: &str,
    skip_unreadable: bool,
) -> CommandResult<Option<(SecretsBlock, usize)>> {
    export_secrets::validate_password(password)?;
    let exportable = store.secrets_for_export(vault).await?;
    let exported: Vec<&JsonMap> = sites
        .iter()
        .filter_map(Value::as_object)
        .filter(|site| is_server_entry(site))
        .collect();
    let exported_id = |site: &JsonMap| site.get("id").and_then(Value::as_str).map(str::to_owned);
    let unreadable: Vec<String> = exportable
        .unreadable
        .iter()
        .filter(|(id, _)| {
            exported
                .iter()
                .any(|site| exported_id(site).as_ref() == Some(id))
        })
        .map(|(_, name)| name.clone())
        .collect();
    if !unreadable.is_empty() && !skip_unreadable {
        let mut error = CommandError::new(
            ErrorCode::SavedSecretUnreadable,
            "Some saved passwords cannot be opened on this computer",
        );
        error.details = Some(unreadable.join("\n"));
        return Err(error);
    }
    let mut count = 0;
    let entries: Vec<SealEntry> = exported
        .iter()
        .filter_map(|site| {
            let id = site.get("id").and_then(Value::as_str)?;
            let secrets = exportable.by_id.get(id)?;
            count += usize::from(secrets.password.is_some())
                + usize::from(secrets.key_passphrase.is_some());
            Some(SealEntry {
                id,
                scope: site_scope(site),
                password: secrets.password.as_deref().map(String::as_str),
                key_passphrase: secrets.key_passphrase.as_deref().map(String::as_str),
            })
        })
        .collect();
    if entries.is_empty() {
        return Ok(None);
    }
    Ok(Some((
        export_secrets::seal(password, &entries).await?,
        count,
    )))
}

/// An export with the saved passwords is confirmed before it gets here, by
/// its grant: with a vault, the confirmation asks for the master password or
/// Windows Hello even while the vault is open.
#[tauri::command]
// Five of these are managed state and handles Tauri injects.
#[allow(clippy::too_many_arguments)]
pub async fn app_export_settings(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    app: AppHandle,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    options: ExportSettingsOptions,
    export_password: Option<String>,
) -> CommandResult<ExportResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        crate::security::sensitive::SensitiveOperation::AppExportSettings,
        export_target(options.include_secrets),
    )?;
    let export_password = zeroize::Zeroizing::new(export_password.unwrap_or_default());
    let exports_secrets = options.include_secrets && options.include_bookmarks;
    if exports_secrets {
        export_secrets::validate_password(&export_password)?;
    }

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
    let mut sealed = 0;
    if options.include_bookmarks || options.include_local_paths {
        // A failed read is an error, not an export that quietly has no bookmarks.
        let sites = store.list_sites().await?;
        let stripped: Vec<serde_json::Value> = sites
            .into_iter()
            .filter(|site| {
                if is_local_scope_entry(site) {
                    options.include_local_paths
                } else {
                    options.include_bookmarks
                }
            })
            .map(|site| serde_json::Value::Object(strip_site_secrets(site)))
            .collect();
        if stripped.len() > MAX_IMPORTED_SITES {
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                format!("An export holds at most {MAX_IMPORTED_SITES} bookmarks and folders"),
            ));
        }
        if exports_secrets
            && let Some((block, count)) = seal_secrets(
                &store,
                &vault,
                &stripped,
                &export_password,
                options.skip_unreadable,
            )
            .await?
        {
            payload.insert(
                "formatVersion".into(),
                Value::from(export_secrets::FORMAT_VERSION),
            );
            payload.insert(
                "secrets".into(),
                serde_json::to_value(block).map_err(anyhow::Error::from)?,
            );
            sealed = count;
        }
        payload.insert("sites".into(), serde_json::Value::Array(stripped));
    }

    let body = serde_json::to_string_pretty(&payload).unwrap_or_default();
    // Checked before the file is written: an import refuses a larger one.
    if body.len() as u64 > MAX_IMPORT_BYTES {
        return Err(CommandError::new(
            ErrorCode::ResourceLimit,
            "The export would exceed the 4 MiB an import accepts",
        ));
    }
    let Some(path_str) = crate::runtime::save_dialog::save_path(
        &app,
        "Export FTPeach settings",
        "ftpeach-settings.json".into(),
        ("JSON", &["json"]),
    )
    .await
    else {
        return Ok(ExportResult::Canceled {
            ok: false,
            canceled: true,
        });
    };
    match write_export(std::path::Path::new(&path_str), body.as_bytes()) {
        Ok(()) => Ok(ExportResult::Ok {
            ok: true,
            path: path_str,
            secrets: sealed,
        }),
        Err(e) => Err(CommandError::from(e)),
    }
}

/// Puts `bytes` at `path` whole or not at all. The temporary file is new and
/// named for this write alone, so it never replaces a file the user has
/// beside it, and only it is removed when something fails.
fn write_export(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("the export needs a file name"))?;
    let mut temporary = std::ffi::OsString::from(".");
    temporary.push(name);
    temporary.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = path.with_file_name(temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&temporary, path)
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum PreviewResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        ok: bool,
        /// The file has saved passwords for the bookmarks being imported:
        /// the import asks for the file's password, or goes without them.
        has_secrets: bool,
    },
    Canceled {
        ok: bool,
        canceled: bool,
    },
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum ImportResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        ok: bool,
        // Absent, not null: the frontend's response check accepts a missing
        // map but rejects null, and would report a finished import as failed.
        #[serde(skip_serializing_if = "Option::is_none")]
        settings: Option<JsonMap>,
        sites_added: usize,
        sites_skipped: usize,
        secrets_saved: usize,
        flags_restored: usize,
        /// Bookmarks whose password stayed behind because the file now sends
        /// them elsewhere than the password was saved for.
        scope_mismatches: Vec<String>,
        /// Duplicates whose passwords had no single bookmark here to go to.
        unmatched: Vec<String>,
    },
}

/// An import that stopped. What stopped it goes to the log here, whatever the
/// code, and to the window with the error.
fn import_failed(mut error: CommandError, issues: Vec<String>) -> CommandError {
    let issues = issues.join("\n");
    log::warn!("Settings import refused ({:?}): {issues}", error.code);
    error.details = Some(match error.details.take() {
        Some(details) => format!("{issues}\n{details}"),
        None => issues,
    });
    error
}

/// Says what was wrong with the file in words a user can act on; serde's own
/// text ("EOF while parsing a value") is only the detail.
fn parse_failure_reason(error: &serde_json::Error) -> String {
    if error.is_data() {
        format!("The file is not a settings file exported by FTPeach: {error}")
    } else {
        format!(
            "The file is not a settings file exported by FTPeach, or it is damaged (line {}, column {}).",
            error.line(),
            error.column()
        )
    }
}

const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMPORTED_SITES: usize = export_secrets::MAX_ENTRIES;

/// Without `formatVersion` and `secrets` the format is what it always was.
/// An older FTPeach refuses a file that has them (it denies unknown fields);
/// this one keeps reading files without them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportDocument {
    #[serde(default)]
    format_version: Option<u32>,
    #[serde(default)]
    exported_at: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    settings: Option<JsonMap>,
    #[serde(default)]
    sites: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    secrets: Option<SecretsBlock>,
}

fn validate_import_settings(patch: &JsonMap) -> Result<(), String> {
    crate::store::validate_settings(patch, false)
}

pub(crate) fn validate_import_site(record: &JsonMap, index: usize) -> Result<(), String> {
    // What a bookmark, a local folder and a folder hold besides a server's
    // settings.
    const ENTRY: &[&str] = &[
        "id",
        "kind",
        "name",
        "icon",
        "color",
        "parentId",
        "localPath",
        "managerScope",
        // strip_site_secrets sets these on export; the import recomputes them.
        "hasPassword",
        "hasKeyPassphrase",
    ];
    for key in record.keys() {
        if SITE_INPUT.contains(&key.as_str()) || SITE_SAVED.contains(&key.as_str()) {
            return Err(format!(
                "sites[{index}].{key}: secret fields cannot be imported"
            ));
        }
        if !ENTRY.contains(&key.as_str())
            && !crate::domain::ServerSettings::KEYS.contains(&key.as_str())
        {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettingsOptions {
    include_settings: bool,
    include_bookmarks: bool,
    include_local_paths: bool,
}

/// How long a previewed file waits for the user to answer.
const STAGED_TTL: Duration = Duration::from_secs(15 * 60);

/// A file read and checked by `app_import_preview`, waiting for
/// `app_import_apply`. It stays through a failed apply, so a wrong password
/// or a locked vault is answered without choosing the file again; the plan
/// of what to write is made anew by every apply.
struct Staged {
    window: String,
    expires: Instant,
    settings: Option<JsonMap>,
    sites: Vec<JsonMap>,
    /// Every server bookmark id in the file, whichever were chosen: the
    /// secrets may name only these.
    site_ids: HashSet<String>,
    secrets: Option<SecretsBlock>,
}

/// The one import waiting for an answer. Its lock is held through a whole
/// apply, so two applies never run at once.
#[derive(Default)]
pub struct StagedImport(tokio::sync::Mutex<Option<Staged>>);

async fn read_import_file(path: &str) -> CommandResult<String> {
    let metadata = tokio::fs::metadata(path).await.map_err(|error| {
        import_failed(
            CommandError::from(error),
            vec!["Cannot inspect the selected import file".into()],
        )
    })?;
    let too_big = |issue: String| {
        import_failed(
            CommandError::new(
                ErrorCode::ResourceLimit,
                "Import file exceeds the 4 MiB limit",
            ),
            vec![issue],
        )
    };
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(too_big(format!(
            "File size is {} bytes; maximum is {MAX_IMPORT_BYTES}",
            metadata.len()
        )));
    }
    use tokio::io::AsyncReadExt;
    let cannot_read = |error: CommandError| {
        import_failed(error, vec!["Cannot read the selected import file".into()])
    };
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| cannot_read(CommandError::from(error)))?;
    let mut bytes = Vec::new();
    file.take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| cannot_read(CommandError::from(error)))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(too_big(
            "File grew beyond the size limit while being read".into(),
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        import_failed(
            CommandError::new(ErrorCode::InvalidInput, "Import file must be UTF-8 JSON"),
            vec!["Invalid UTF-8".into()],
        )
    })
}

/// Checks a parsed file and keeps what `options` chose of it. Everything
/// that can be judged without the file's password is judged here.
fn stage(
    mut data: ImportDocument,
    options: &ImportSettingsOptions,
    window: &str,
) -> Result<Staged, Vec<String>> {
    let _ = (&data.exported_at, &data.app_version);
    let mut issues = Vec::new();
    match (data.format_version, &data.secrets) {
        (None, None) => {}
        (Some(export_secrets::FORMAT_VERSION), Some(block)) => {
            if let Err(error) = export_secrets::check(block) {
                issues.push(CommandError::from_anyhow(&error).message);
            }
        }
        (Some(version), _) if version > export_secrets::FORMAT_VERSION => issues.push(format!(
            "formatVersion {version}: the file was made by a newer FTPeach"
        )),
        _ => issues.push("formatVersion and secrets do not go together".into()),
    }
    let mut site_ids = HashSet::new();
    let mut ids = HashSet::new();
    for (index, site) in data.sites.iter().flatten().enumerate() {
        let Some(record) = site.as_object() else {
            continue;
        };
        if let Some(id) = record.get("id").and_then(Value::as_str) {
            if !ids.insert(id) {
                issues.push(format!("sites[{index}].id: {id} appears twice"));
            }
            if is_server_entry(record) {
                site_ids.insert(id.to_owned());
            }
        }
    }

    // Options gate what's applied, independent of what the file contains —
    // mirrors the checkbox filter in app_export_settings.
    if !options.include_settings {
        data.settings = None;
    }
    if let Some(sites) = data.sites.as_mut() {
        sites.retain(|site| match site.as_object() {
            Some(record) if is_local_scope_entry(record) => options.include_local_paths,
            Some(_) => options.include_bookmarks,
            None => true, // malformed entry — let validation below report it
        });
    }
    if let Some(settings) = data.settings.as_ref()
        && let Err(issue) = validate_import_settings(settings)
    {
        issues.push(issue);
    }
    let mut sites = Vec::new();
    if let Some(entries) = data.sites {
        if entries.len() > MAX_IMPORTED_SITES {
            issues.push(format!("sites: more than {MAX_IMPORTED_SITES} entries"));
        }
        for (index, site) in entries.into_iter().enumerate() {
            match site {
                serde_json::Value::Object(record) => {
                    if let Err(issue) = validate_import_site(&record, index) {
                        issues.push(issue);
                    }
                    sites.push(record);
                }
                _ => issues.push(format!("sites[{index}]: expected an object")),
            }
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let secrets = data.secrets.filter(|_| sites.iter().any(is_server_entry));
    Ok(Staged {
        window: window.to_owned(),
        expires: Instant::now() + STAGED_TTL,
        settings: data.settings,
        sites,
        site_ids,
        secrets,
    })
}

/// Chooses and checks the file to import, and keeps it for
/// `app_import_apply`. Nothing is written here.
#[tauri::command]
pub async fn app_import_preview(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    app: AppHandle,
    staged: State<'_, StagedImport>,
    options: ImportSettingsOptions,
) -> CommandResult<PreviewResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        crate::security::sensitive::SensitiveOperation::AppImportPreview,
        "native-dialog",
    )?;
    // A new file replaces whatever was waiting.
    staged.0.lock().await.take();
    // The desktop tests answer for the user, since nothing can drive the native dialog.
    #[cfg(feature = "smoke-test")]
    let answered = crate::runtime::e2e_browser::picked_path();
    #[cfg(not(feature = "smoke-test"))]
    let answered: Option<Option<String>> = None;
    let picked = match answered {
        Some(answer) => answer,
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title("Import FTPeach settings")
                .add_filter("JSON", &["json"])
                .pick_file(move |path| {
                    let _ = tx.send(path);
                });
            rx.await.ok().flatten().map(|path| path.to_string())
        }
    };
    let Some(path) = picked else {
        return Ok(PreviewResult::Canceled {
            ok: false,
            canceled: true,
        });
    };
    let raw = read_import_file(&path).await?;
    let data: ImportDocument = serde_json::from_str(&raw).map_err(|e| {
        import_failed(
            CommandError::new(
                ErrorCode::InvalidInput,
                "Import file does not match the supported schema",
            ),
            vec![parse_failure_reason(&e)],
        )
    })?;
    let next = stage(data, &options, window.label()).map_err(|issues| {
        import_failed(
            CommandError::new(ErrorCode::InvalidInput, "Import validation failed"),
            issues,
        )
    })?;
    let has_secrets = next.secrets.is_some();
    *staged.0.lock().await = Some(next);
    Ok(PreviewResult::Ok {
        ok: true,
        has_secrets,
    })
}

/// The secrets of a staged file opened with `password`, keyed by the ids
/// its bookmarks have in the file.
async fn open_secrets(
    staged: &Staged,
    password: Option<&str>,
) -> CommandResult<HashMap<String, ImportedSecret>> {
    let (Some(block), Some(password)) = (&staged.secrets, password) else {
        return Ok(HashMap::new());
    };
    let mut secrets = HashMap::new();
    for entry in export_secrets::open(password, block).await? {
        if !staged.site_ids.contains(&entry.id) {
            return Err(CommandError::new(
                ErrorCode::InvalidInput,
                format!("secrets: {} names no bookmark in the file", entry.id),
            ));
        }
        secrets.insert(
            entry.id,
            ImportedSecret {
                scope: entry.scope,
                password: entry.password,
                key_passphrase: entry.key_passphrase,
            },
        );
    }
    Ok(secrets)
}

/// Writes the bookmarks first and the settings last, so only the bookmarks
/// and the vault ever need undoing: a settings save that fails undoes them.
async fn apply_import(
    store: Store,
    vault: Vault,
    sites: Vec<JsonMap>,
    secrets: HashMap<String, ImportedSecret>,
    settings: Option<JsonMap>,
) -> Result<(SitesImported, Option<JsonMap>), ImportFailed> {
    let (outcome, import) = store.import_sites(&vault, &sites, secrets).await?;
    let mut saved = None;
    if let Some(patch) = settings {
        // Relaxing protection or moving the saved proxy password needs its
        // own confirmation; an import keeps the current values instead.
        let patch = crate::security::security_policy::without_unconfirmed_changes(
            &store.get_settings().await,
            patch,
        );
        match store.set_settings(patch).await {
            Ok(next) => saved = Some(next),
            Err(error) => {
                return Err(ImportFailed {
                    error: error.context("Settings could not be saved"),
                    not_restored: import.rollback().await,
                });
            }
        }
    }
    drop(import);
    Ok((outcome, saved))
}

/// Imports the file `app_import_preview` kept: with its saved passwords
/// when `password` opens them, without them when it is absent.
#[tauri::command]
// Six of these are managed state Tauri injects.
#[allow(clippy::too_many_arguments)]
pub async fn app_import_apply(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    app: AppHandle,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    auto_lock: State<'_, crate::security::auto_lock::AutoLock>,
    staged: State<'_, StagedImport>,
    password: Option<String>,
) -> CommandResult<ImportResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        crate::security::sensitive::SensitiveOperation::AppImportApply,
        "staged-import",
    )?;
    let password = password.map(zeroize::Zeroizing::new);
    let mut slot = staged.0.lock().await;
    let gone = || {
        CommandError::new(
            ErrorCode::NotFound,
            "The file to import is no longer waiting; choose it again",
        )
    };
    let current = slot.as_ref().ok_or_else(gone)?;
    if current.window != window.label() {
        return Err(gone());
    }
    if current.expires <= Instant::now() {
        slot.take();
        return Err(gone());
    }
    let secrets = open_secrets(current, password.as_deref().map(String::as_str))
        .await
        .map_err(|error| {
            import_failed(error, vec!["The saved passwords were not opened".into()])
        })?;
    let task = tokio::spawn(apply_import(
        store.inner().clone(),
        vault.inner().clone(),
        current.sites.clone(),
        secrets,
        current.settings.clone(),
    ));
    let (outcome, settings) = match task.await {
        Ok(Ok(done)) => done,
        Ok(Err(ImportFailed {
            error,
            not_restored,
        })) => {
            // The first line is what the window shows: what is left over
            // when the undo itself failed, otherwise that nothing changed.
            let first = if not_restored.is_empty() {
                "Nothing was imported; the bookmarks and settings are as they were".to_owned()
            } else {
                format!(
                    "The import failed and could not be fully undone. {}",
                    not_restored.join(" ")
                )
            };
            return Err(import_failed(
                CommandError::from_anyhow(&error),
                vec![first],
            ));
        }
        Err(error) => {
            return Err(CommandError::from_anyhow(&anyhow::anyhow!(
                "import task failed: {error}"
            )));
        }
    };
    slot.take();
    drop(slot);
    if let Some(next) = settings.as_ref() {
        crate::runtime::settings_apply::apply(
            next,
            &store,
            &tauri::Manager::state::<crate::runtime::log_emitter::LogEmitter>(&app),
        );
        crate::runtime::vault_auto_lock::apply_idle_timeout(next, &auto_lock);
    }
    Ok(ImportResult::Ok {
        ok: true,
        settings,
        sites_added: outcome.added,
        sites_skipped: outcome.skipped,
        secrets_saved: outcome.secrets_saved,
        flags_restored: outcome.flags_restored,
        scope_mismatches: outcome.scope_mismatches,
        unmatched: outcome.unmatched,
    })
}

/// Forgets the file `app_import_preview` kept.
#[tauri::command]
pub async fn app_import_discard(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    staged: State<'_, StagedImport>,
) -> CommandResult<()> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        crate::security::sensitive::SensitiveOperation::AppImportDiscard,
        "staged-import",
    )?;
    let mut slot = staged.0.lock().await;
    if slot
        .as_ref()
        .is_some_and(|current| current.window == window.label())
    {
        slot.take();
    }
    Ok(())
}

#[cfg(test)]
#[path = "app_settings_transfer_tests.rs"]
mod tests;
