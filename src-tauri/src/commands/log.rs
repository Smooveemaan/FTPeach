use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::runtime::app_log;
use crate::runtime::diagnostics::redact;
use crate::runtime::log_emitter::{LogEmitter, LogRecord};
use crate::store::Store;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct OkFlag {
    ok: bool,
}

#[tauri::command]
pub async fn log_set_file_logging(
    emitter: State<'_, LogEmitter>,
    enabled: bool,
) -> CommandResult<OkFlag> {
    emitter.set_file_logging_enabled(enabled);
    Ok(OkFlag { ok: true })
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
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save log")
        .set_file_name(format!("ftpeach-log-{stamp}.txt"))
        .add_filter("Text", &["txt"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(LogSaveResult::Canceled {
            ok: false,
            canceled: true,
        });
    };
    let path_str = path.to_string();
    match tokio::fs::write(&path_str, redact(&content)).await {
        Ok(()) => Ok(LogSaveResult::Ok {
            ok: true,
            path: path_str,
        }),
        Err(error) => Err(CommandError::from(error)),
    }
}

/// Builds the bundle from what the backend holds itself — the protocol log in
/// memory and the end of the application log — so it has the history even when
/// the log panel was never opened.
#[tauri::command]
pub async fn log_export_diagnostics(
    app: AppHandle,
    emitter: State<'_, LogEmitter>,
    store: State<'_, Store>,
) -> CommandResult<LogSaveResult> {
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H-%M-%S").to_string();
    let bundle = serde_json::json!({
        "metadata": {
            "application": "FTPeach", "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS, "architecture": std::env::consts::ARCH,
            "supportedProtocols": ["ftp", "ftps", "sftp", "webdav"],
            "generatedAt": chrono::Utc::now().to_rfc3339(), "telemetrySent": false
        },
        "protocolLog": emitter.diagnostic_records(),
        "applicationLog": app_log::tail(&store.logs_dir()).await,
    });
    let serialized = serde_json::to_string_pretty(&bundle)
        .map_err(anyhow::Error::from)
        .map_err(CommandError::from)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export diagnostic bundle")
        .set_file_name(format!("ftpeach-diagnostics-{stamp}.json"))
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(LogSaveResult::Canceled {
            ok: false,
            canceled: true,
        });
    };
    let path_str = path.to_string();
    tokio::fs::write(&path_str, serialized)
        .await
        .map_err(CommandError::from)?;
    Ok(LogSaveResult::Ok {
        ok: true,
        path: path_str,
    })
}

fn validate_log_size(content: &str) -> CommandResult<()> {
    if content.len() > crate::runtime::diagnostics::MAX_RENDERER_LOG_BYTES {
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

    #[test]
    fn renderer_log_limit_accepts_boundary_and_rejects_one_more_byte() {
        assert!(
            validate_log_size(&"x".repeat(crate::runtime::diagnostics::MAX_RENDERER_LOG_BYTES))
                .is_ok()
        );
        let error =
            validate_log_size(&"x".repeat(crate::runtime::diagnostics::MAX_RENDERER_LOG_BYTES + 1))
                .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
    }
}
