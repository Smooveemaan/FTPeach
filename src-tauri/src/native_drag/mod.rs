//! Native OS drag-and-drop for dragging a remote file out of FTPeach onto
//! the system file explorer (Windows Explorer, macOS Finder).
pub mod macos;
#[cfg(all(windows, not(feature = "test-utils")))]
mod manifest;
#[cfg(all(windows, feature = "test-utils"))]
pub mod manifest;
pub mod report;
#[cfg(windows)]
pub mod windows;
#[allow(unused_imports)]
pub use report::TransferReporter;

use serde::Deserialize;

/// One remote file the user is dragging out. Deserialized from the drag-out
/// command's arguments and consumed by the platform drag implementation, so it
/// belongs to the drag, not to the command that starts it.
///
/// `size` is passed through from the directory listing already held by the
/// pane — best-effort only, used for the virtual-file descriptor's optional
/// size field and the OS copy dialog's progress bar, never trusted for
/// anything security-relevant.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutFile {
    pub remote_path: String,
    pub name: String,
    pub size: Option<u64>,
    #[serde(default)]
    pub is_directory: bool,
}

#[cfg(any(windows, target_os = "macos"))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DragMotion {
    x: f64,
    y: f64,
    ended: bool,
    cancelled: bool,
}

#[cfg(any(windows, target_os = "macos"))]
fn report_motion(window: &tauri::Window, ended: bool, cancelled: bool) {
    use tauri::Emitter;
    if let (Ok(cursor), Ok(origin)) = (window.cursor_position(), window.inner_position()) {
        let scale = if cfg!(target_os = "macos") {
            window.scale_factor().unwrap_or(1.0)
        } else {
            1.0
        };
        let _ = window.emit(
            "drag-out-motion",
            DragMotion {
                x: (cursor.x - f64::from(origin.x)) / scale,
                y: (cursor.y - f64::from(origin.y)) / scale,
                ended,
                cancelled,
            },
        );
    }
}
