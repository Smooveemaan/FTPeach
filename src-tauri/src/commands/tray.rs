use crate::runtime::tray::{self, TrayState};
use tauri::{State, WebviewWindow};

#[tauri::command]
pub fn tray_set_labels(tray: State<'_, TrayState>, show: String, quit: String) {
    tray.set_labels(show, quit);
}

#[tauri::command]
pub fn tray_hide_window(window: WebviewWindow) {
    tray::hide_to_tray(window);
}
