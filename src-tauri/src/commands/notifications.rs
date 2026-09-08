use crate::ipc::{CommandError, CommandResult};
use crate::store::Store;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    #[serde(default)]
    succeeded: u32,
    #[serde(default)]
    failed: u32,
    title: String,
    body: String,
}

fn should_notify(app: &AppHandle) -> bool {
    match app.get_webview_window("main") {
        Some(w) => !w.is_focused().unwrap_or(false),
        None => true,
    }
}

#[tauri::command]
pub async fn notifications_transfers_complete(
    app: AppHandle,
    store: State<'_, Store>,
    summary: TransferSummary,
) -> CommandResult<()> {
    let settings = store.get_settings().await;
    let notify_enabled = settings
        .get("notifyOnTransferComplete")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !notify_enabled {
        return Ok(());
    }
    if summary.succeeded == 0 && summary.failed == 0 {
        return Ok(());
    }
    if !should_notify(&app) {
        return Ok(());
    }

    app.notification()
        .builder()
        .title(summary.title)
        .body(summary.body)
        .show()
        .map_err(|error| CommandError::from_anyhow(&anyhow::anyhow!(error.to_string())))?;
    Ok(())
}
