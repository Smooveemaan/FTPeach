use crate::runtime::tray::TrayState;
use tauri::State;

#[tauri::command]
pub fn tray_set_labels(tray: State<'_, TrayState>, show: String, quit: String) {
    let _ = tray.show_item.set_text(show);
    let _ = tray.quit_item.set_text(quit);
}
