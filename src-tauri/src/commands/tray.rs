use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::runtime::tray::{self, model::TrayModel};
use tauri::{AppHandle, WebviewWindow};

#[tauri::command]
pub fn tray_set_model(app: AppHandle, model: TrayModel) -> CommandResult<()> {
    model
        .validate()
        .map_err(|message| CommandError::new(ErrorCode::InvalidInput, message))?;
    tray::set_model(&app, model);
    Ok(())
}

#[tauri::command]
pub fn tray_hide_window(window: WebviewWindow) {
    tray::hide_to_tray(window);
}
