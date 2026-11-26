use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::open_with::OpenWithWatchers;
use crate::runtime::app_log;
use crate::runtime::log_emitter::{LogEmitter, LogRecord};
use crate::security::redaction::redact;
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Sessions};
use crate::store::{JsonMap, Store};
use crate::terminal::Terminals;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Largest renderer log the user can save to a file.
const MAX_RENDERER_LOG_BYTES: usize = 2 * 1024 * 1024;

/// Non-secret settings included in exported diagnostic bundles. Everything
/// else (credentials, proxy auth, user paths, unknown keys) is omitted.
const DIAGNOSTIC_SETTING_KEYS: &[&str] = &[
    "theme",
    "colorScheme",
    "language",
    "interfaceScale",
    "contentZoom",
    "closeToTray",
    "minimizeToTray",
    "concurrency",
    "transferSpeedLimitKBps",
    "logEnabled",
    "logToFile",
    "extendedLogging",
    "autoLockMinutes",
    "dateFormat",
];

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshot {
    sessions_count: usize,
    connecting_count: usize,
    terminals_count: usize,
    open_with_watchers_count: usize,
    vault_configured: bool,
    vault_locked: bool,
}

/// Opens the folder the Logging settings show, `folder` as typed there and
/// maybe not saved yet; empty is FTPeach's own logs folder. Saving the
/// setting would point the log at it anyway, so this opens nothing new.
#[tauri::command]
pub async fn log_open_folder(
    app: AppHandle,
    store: State<'_, Store>,
    folder: String,
) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::runtime::settings_apply::log_folder(&folder, &store);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| CommandError::from_anyhow(&error.into()))?;
    #[cfg(feature = "smoke-test")]
    if crate::runtime::e2e_browser::hold_back_opening(&dir.to_string_lossy()) {
        return Ok(());
    }
    app.opener()
        .open_path(
            crate::local_fs::local_open::external_path(&dir),
            None::<String>,
        )
        .map_err(|error| CommandError::from_anyhow(&anyhow::anyhow!(error.to_string())))
}

/// The protocol log still in memory, oldest first. The panel reads it when it
/// opens and then follows `protocol:log`.
#[tauri::command]
pub async fn log_recent(emitter: State<'_, LogEmitter>) -> CommandResult<Vec<LogRecord>> {
    Ok(emitter.recent())
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum LogSaveResult {
    Ok { ok: bool, path: String },
    Canceled { ok: bool, canceled: bool },
}

#[tauri::command]
pub async fn log_save(app: AppHandle, content: String) -> CommandResult<LogSaveResult> {
    validate_log_size(&content)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H-%M-%S").to_string();
    let Some(path_str) = crate::runtime::file_dialog::save_path(
        &app,
        "Save log",
        format!("ftpeach-log-{stamp}.txt"),
        ("Text", &["txt"]),
    )
    .await
    else {
        return Ok(LogSaveResult::Canceled {
            ok: false,
            canceled: true,
        });
    };
    match tokio::fs::write(&path_str, redact(&content)).await {
        Ok(()) => Ok(LogSaveResult::Ok {
            ok: true,
            path: path_str,
        }),
        Err(error) => Err(CommandError::from(error)),
    }
}

/// Builds the bundle from what the backend holds itself — environment snapshot,
/// recent flight-recorder events, the protocol log in memory and the end of the
/// application log — so it has the history even when the log panel was never
/// opened.
#[tauri::command]
pub async fn log_export_diagnostics(
    app: AppHandle,
    emitter: State<'_, LogEmitter>,
    store: State<'_, Store>,
) -> CommandResult<LogSaveResult> {
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H-%M-%S").to_string();
    let all_settings = store.get_settings().await;
    let runtime = collect_runtime_snapshot(&app).await;
    let (monitors, main_window) = collect_window_snapshot(&app);
    let application_log = app_log::tail(&store.logs_dir()).await;
    let bundle = build_diagnostics_bundle(
        &all_settings,
        monitors,
        main_window,
        runtime,
        app_log::recent_events(),
        emitter.diagnostic_records(),
        application_log,
    );
    let serialized = serde_json::to_string_pretty(&bundle)
        .map_err(anyhow::Error::from)
        .map_err(CommandError::from)?;
    let Some(path_str) = crate::runtime::file_dialog::save_path(
        &app,
        "Export diagnostic bundle",
        format!("ftpeach-diagnostics-{stamp}.json"),
        ("JSON", &["json"]),
    )
    .await
    else {
        return Ok(LogSaveResult::Canceled {
            ok: false,
            canceled: true,
        });
    };
    tokio::fs::write(&path_str, serialized)
        .await
        .map_err(CommandError::from)?;
    Ok(LogSaveResult::Ok {
        ok: true,
        path: path_str,
    })
}

fn filter_diagnostic_settings(all: &JsonMap) -> JsonMap {
    let mut filtered = JsonMap::new();
    for &key in DIAGNOSTIC_SETTING_KEYS {
        if let Some(value) = all.get(key) {
            filtered.insert(key.to_string(), value.clone());
        }
    }
    filtered
}

fn build_diagnostics_bundle(
    all_settings: &JsonMap,
    monitors: Vec<serde_json::Value>,
    main_window: serde_json::Value,
    runtime: RuntimeSnapshot,
    flight_recorder: Vec<String>,
    protocol_log: Vec<serde_json::Value>,
    application_log: Vec<String>,
) -> serde_json::Value {
    let portable = crate::local_fs::portable::root().is_some();
    let extended_logging_until = all_settings
        .get("extendedLoggingUntil")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "metadata": {
            "application": "FTPeach",
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "supportedProtocols": ["ftp", "ftps", "sftp", "webdav"],
            "portable": portable,
            "generatedAt": chrono::Utc::now().to_rfc3339(),
            "telemetrySent": false
        },
        "environment": {
            "os": std::env::consts::OS,
            "osVersion": os_version(),
            "architecture": std::env::consts::ARCH,
            "version": env!("CARGO_PKG_VERSION"),
            "portable": portable,
            "extendedLogging": app_log::is_extended_enabled(),
            "extendedLoggingUntil": extended_logging_until,
            "monitors": monitors,
            "mainWindow": main_window,
            "settings": filter_diagnostic_settings(all_settings),
            "runtime": runtime
        },
        "flightRecorder": flight_recorder,
        "protocolLog": protocol_log,
        "applicationLog": application_log,
    })
}

async fn collect_runtime_snapshot(app: &AppHandle) -> RuntimeSnapshot {
    let sessions_count = app
        .try_state::<Sessions>()
        .map(|s| s.slot_count())
        .unwrap_or(0);
    let connecting_count = app
        .try_state::<ConnectingClients>()
        .map(|c| c.count())
        .unwrap_or(0);
    let terminals_count = app
        .try_state::<Terminals>()
        .map(|t| t.active_count())
        .unwrap_or(0);
    let open_with_watchers_count = app
        .try_state::<OpenWithWatchers>()
        .map(|w| w.watcher_count())
        .unwrap_or(0);
    let (vault_configured, vault_locked) = match app.try_state::<Vault>() {
        Some(vault) => {
            let configured = vault.is_configured();
            let locked = configured && !vault.is_unlocked().await;
            (configured, locked)
        }
        None => (false, false),
    };
    RuntimeSnapshot {
        sessions_count,
        connecting_count,
        terminals_count,
        open_with_watchers_count,
        vault_configured,
        vault_locked,
    }
}

fn collect_window_snapshot(app: &AppHandle) -> (Vec<serde_json::Value>, serde_json::Value) {
    let Some(window) = app.get_webview_window("main") else {
        return (Vec::new(), serde_json::Value::Null);
    };
    let monitors = window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| {
            let size = monitor.size();
            let work = monitor.work_area();
            serde_json::json!({
                "size": { "width": size.width, "height": size.height },
                "workArea": {
                    "x": work.position.x,
                    "y": work.position.y,
                    "width": work.size.width,
                    "height": work.size.height
                },
                "scaleFactor": monitor.scale_factor()
            })
        })
        .collect();
    let main_window = serde_json::json!({
        "innerSize": window.inner_size().ok().map(|s| serde_json::json!({ "width": s.width, "height": s.height })),
        "outerPosition": window.outer_position().ok().map(|p| serde_json::json!({ "x": p.x, "y": p.y })),
        "scaleFactor": window.scale_factor().ok(),
        "maximized": window.is_maximized().ok(),
        "minimized": window.is_minimized().ok(),
        "visible": window.is_visible().ok(),
    });
    (monitors, main_window)
}

#[cfg(windows)]
fn os_version() -> Option<String> {
    let key = windows_registry::LOCAL_MACHINE
        .open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .ok()?;
    let build = key.get_string("CurrentBuildNumber").ok()?;
    let ubr = key.get_u32("UBR").ok();
    let display = key
        .get_string("DisplayVersion")
        .ok()
        .filter(|value| !value.is_empty());
    let build_str = match ubr {
        Some(revision) => format!("{build}.{revision}"),
        None => build,
    };
    Some(match display {
        Some(name) => format!("{name} (build {build_str})"),
        None => format!("build {build_str}"),
    })
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let value = plist::Value::from_file("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    let dict = value.as_dictionary()?;
    let version = dict.get("ProductVersion")?.as_string()?;
    let build = dict.get("ProductBuildVersion").and_then(|v| v.as_string());
    Some(match build {
        Some(build) => format!("{version} ({build})"),
        None => version.to_string(),
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_version() -> Option<String> {
    let contents = std::fs::read_to_string("/etc/os-release").ok()?;
    for line in contents.lines() {
        if let Some(raw) = line.strip_prefix("PRETTY_NAME=") {
            let trimmed = raw.trim().trim_matches('"');
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(not(any(windows, unix)))]
fn os_version() -> Option<String> {
    None
}

fn validate_log_size(content: &str) -> CommandResult<()> {
    if content.len() > MAX_RENDERER_LOG_BYTES {
        return Err(CommandError::new(
            ErrorCode::ResourceLimit,
            "Log content exceeds the 2 MiB limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renderer_log_limit_accepts_boundary_and_rejects_one_more_byte() {
        assert!(validate_log_size(&"x".repeat(MAX_RENDERER_LOG_BYTES)).is_ok());
        let error = validate_log_size(&"x".repeat(MAX_RENDERER_LOG_BYTES + 1)).unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
    }

    #[test]
    fn diagnostic_settings_allowlist_strips_secrets_and_paths() {
        let mut all = JsonMap::new();
        all.insert("theme".into(), json!("dark"));
        all.insert("colorScheme".into(), json!("peach"));
        all.insert("language".into(), json!("en"));
        all.insert("closeToTray".into(), json!(true));
        all.insert("extendedLogging".into(), json!(false));
        all.insert("proxyPasswordPlain".into(), json!("super-secret"));
        all.insert("proxyUsername".into(), json!("alice"));
        all.insert("proxyHost".into(), json!("proxy.internal"));
        all.insert("logFolder".into(), json!("C:\\Users\\alice\\private-logs"));
        all.insert("defaultLocalPath".into(), json!("C:\\Users\\alice\\docs"));
        all.insert("customUnknownKey".into(), json!("should-not-leak"));

        let filtered = filter_diagnostic_settings(&all);
        assert_eq!(filtered.get("theme"), Some(&json!("dark")));
        assert_eq!(filtered.get("colorScheme"), Some(&json!("peach")));
        assert_eq!(filtered.get("language"), Some(&json!("en")));
        assert_eq!(filtered.get("closeToTray"), Some(&json!(true)));
        assert_eq!(filtered.get("extendedLogging"), Some(&json!(false)));
        assert!(!filtered.contains_key("proxyPasswordPlain"));
        assert!(!filtered.contains_key("proxyUsername"));
        assert!(!filtered.contains_key("proxyHost"));
        assert!(!filtered.contains_key("logFolder"));
        assert!(!filtered.contains_key("defaultLocalPath"));
        assert!(!filtered.contains_key("customUnknownKey"));
    }

    #[test]
    fn diagnostics_bundle_includes_environment_and_flight_recorder() {
        let mut settings = JsonMap::new();
        settings.insert("theme".into(), json!("light"));
        settings.insert("proxyPasswordPlain".into(), json!("secret-pw"));

        let bundle = build_diagnostics_bundle(
            &settings,
            vec![json!({
                "size": { "width": 1920, "height": 1080 },
                "workArea": { "x": 0, "y": 0, "width": 1920, "height": 1040 },
                "scaleFactor": 1.25
            })],
            json!({
                "innerSize": { "width": 1200, "height": 800 },
                "outerPosition": { "x": 100, "y": 50 },
                "scaleFactor": 1.25,
                "maximized": false,
                "minimized": false,
                "visible": true
            }),
            RuntimeSnapshot {
                sessions_count: 2,
                connecting_count: 1,
                terminals_count: 1,
                open_with_watchers_count: 3,
                vault_configured: true,
                vault_locked: false,
            },
            vec!["12:00:00.000 [lifecycle] startup: ready".into()],
            Vec::new(),
            vec!["app log tail".into()],
        );

        let serialized = serde_json::to_string(&bundle).unwrap();
        assert!(!serialized.contains("secret-pw"));
        assert_eq!(
            bundle["environment"]["monitors"].as_array().unwrap().len(),
            1
        );
        assert_eq!(bundle["environment"]["mainWindow"]["visible"], json!(true));
        assert_eq!(bundle["environment"]["runtime"]["sessionsCount"], json!(2));
        assert_eq!(
            bundle["environment"]["runtime"]["connectingCount"],
            json!(1)
        );
        assert_eq!(bundle["environment"]["runtime"]["terminalsCount"], json!(1));
        assert_eq!(
            bundle["environment"]["runtime"]["openWithWatchersCount"],
            json!(3)
        );
        assert_eq!(
            bundle["environment"]["runtime"]["vaultConfigured"],
            json!(true)
        );
        assert_eq!(
            bundle["environment"]["runtime"]["vaultLocked"],
            json!(false)
        );
        assert_eq!(
            bundle["environment"]["settings"],
            json!({ "theme": "light" })
        );
        assert_eq!(
            bundle["flightRecorder"],
            json!(["12:00:00.000 [lifecycle] startup: ready"])
        );
    }
}
