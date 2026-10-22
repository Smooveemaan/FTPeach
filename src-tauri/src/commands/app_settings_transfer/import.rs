//! Reading and checking a settings file to import: its size, its schema,
//! every bookmark and setting in it, and the plan staged for the user's answer.
use super::*;

/// An import that stopped. What stopped it goes to the log here, whatever the
/// code, and to the window with the error.
pub(super) fn import_failed(mut error: CommandError, issues: Vec<String>) -> CommandError {
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
pub(super) fn parse_failure_reason(error: &serde_json::Error) -> String {
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

pub(super) const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024;
pub(super) const MAX_IMPORTED_SITES: usize = export_secrets::MAX_ENTRIES;

/// Without `formatVersion` and `secrets` the format is what it always was.
/// An older FTPeach refuses a file that has them (it denies unknown fields);
/// this one keeps reading files without them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportDocument {
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

pub(super) fn validate_import_settings(patch: &JsonMap) -> Result<(), String> {
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
pub(super) async fn read_import_file(path: &str) -> CommandResult<String> {
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
pub(super) fn stage(
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
