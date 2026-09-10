use crate::ipc::{self, CommandError, CommandResult, ErrorCode, OkResult};
use crate::runtime::updater::{self, UpdaterState, UpdaterStatus};
use tauri::{AppHandle, State};

fn outcome(result: anyhow::Result<()>) -> OkResult {
    match result {
        Ok(()) => ipc::ok(),
        Err(error) => OkResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&error),
        },
    }
}

/// What the updater last reported. The startup check begins with the
/// process, so it has often said something before the UI subscribed.
#[tauri::command]
pub fn updater_status(state: State<'_, UpdaterState>) -> Option<UpdaterStatus> {
    state.status()
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> CommandResult<OkResult> {
    if !updater::updates_enabled() {
        updater::report_unavailable(&app);
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::Internal, "Updater unavailable in development"),
        });
    }
    Ok(outcome(updater::check(&app).await))
}

#[tauri::command]
pub async fn updater_download(app: AppHandle) -> CommandResult<OkResult> {
    Ok(outcome(updater::download(&app).await))
}

/// Shuts FTPeach down and hands over to the installer. It answers only when
/// there is no verified download to install.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> CommandResult<OkResult> {
    Ok(outcome(updater::install_now(&app).await))
}
