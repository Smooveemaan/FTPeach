use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::runtime::app_menu::{self, AppMenuModel};
use tauri::AppHandle;

/// Updates the dynamic system menu bar structure (macOS).
#[tauri::command]
pub fn app_menu_set_model(app: AppHandle, model: AppMenuModel) -> CommandResult<()> {
    model
        .validate()
        .map_err(|message| CommandError::new(ErrorCode::InvalidInput, message))?;
    app_menu::set_model(&app, model);
    Ok(())
}
