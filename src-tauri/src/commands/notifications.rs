use crate::ipc::{CommandError, CommandResult};
use crate::runtime::notification;
use crate::store::Store;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

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

/// Whether finished transfers deserve a notification at all: the setting is
/// on (it is unless switched off) and at least one file ended either way.
fn wants_notification(settings: &crate::store::JsonMap, summary: &TransferSummary) -> bool {
    let enabled = settings
        .get("notifyOnTransferComplete")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    enabled && (summary.succeeded > 0 || summary.failed > 0)
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
    if !wants_notification(&store.get_settings().await, &summary) || !should_notify(&app) {
        return Ok(());
    }

    notification::show(&app, &summary.title, &summary.body)
        .map_err(|error| CommandError::from_anyhow(&anyhow::anyhow!(error)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(succeeded: u32, failed: u32) -> TransferSummary {
        TransferSummary {
            succeeded,
            failed,
            ..Default::default()
        }
    }

    #[test]
    fn switching_the_setting_off_silences_finished_transfers() {
        let mut settings = crate::store::JsonMap::new();
        assert!(wants_notification(&settings, &summary(1, 0)));
        settings.insert("notifyOnTransferComplete".into(), true.into());
        assert!(wants_notification(&settings, &summary(0, 1)));
        settings.insert("notifyOnTransferComplete".into(), false.into());
        assert!(!wants_notification(&settings, &summary(3, 2)));
    }

    #[test]
    fn a_queue_that_ended_with_nothing_done_says_nothing() {
        assert!(!wants_notification(
            &crate::store::JsonMap::new(),
            &summary(0, 0)
        ));
    }
}
