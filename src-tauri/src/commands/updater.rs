use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::runtime::updater::{self, UpdaterState, UpdaterStatus};
use tauri::{AppHandle, State};

/// What the updater last reported. The startup check begins with the
/// process, so it has often said something before the UI subscribed.
#[tauri::command]
pub fn updater_status(state: State<'_, UpdaterState>) -> Option<UpdaterStatus> {
    state.status()
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> CommandResult<()> {
    if !updater::updates_enabled() {
        updater::report_unavailable(&app);
        return Err(CommandError::new(
            ErrorCode::Internal,
            "Updater unavailable in development",
        ));
    }
    Ok(updater::check(&app).await?)
}

#[tauri::command]
pub async fn updater_download(app: AppHandle) -> CommandResult<()> {
    Ok(updater::download(&app).await?)
}

/// Shuts FTPeach down and hands over to the installer. It answers only when
/// there is no verified download to install.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> CommandResult<()> {
    Ok(updater::install_now(&app).await?)
}
