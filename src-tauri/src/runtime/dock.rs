//! macOS Dock integration and reopen event handling.
//!
//! On macOS, clicking the application icon in the Dock (or reopening via
//! Finder / Launchpad while the process is running) emits a `Reopen` event.
//! If there are no visible windows (e.g. the window was closed/hidden),
//! the main window is restored and focused. If a window is visible but
//! minimized, it is unminimized and brought to the front.

use tauri::{AppHandle, Manager};

/// What a macOS reopen event requests.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ReopenAction {
    /// Restore the window from hidden/tray state and focus it.
    Restore,
    /// Unminimize and focus an already visible window.
    Focus,
}

/// Decides what action to take when macOS emits a reopen event.
pub fn reopen_action(has_visible_windows: bool) -> ReopenAction {
    if !has_visible_windows {
        ReopenAction::Restore
    } else {
        ReopenAction::Focus
    }
}

/// Handles `tauri::RunEvent::Reopen` on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn handle_reopen(app: &AppHandle, has_visible_windows: bool) {
    match reopen_action(has_visible_windows) {
        ReopenAction::Restore => {
            crate::runtime::tray::restore(app);
        }
        ReopenAction::Focus => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopen_action_restores_when_no_visible_windows() {
        assert_eq!(reopen_action(false), ReopenAction::Restore);
    }

    #[test]
    fn reopen_action_focuses_when_windows_are_visible() {
        assert_eq!(reopen_action(true), ReopenAction::Focus);
    }
}
