//! Native OS drag-and-drop for dragging a remote file out of FTPeach onto
//! the system file explorer. Windows-only for now (see
//! `.local/docs/macos.md` for the macOS/Linux design notes) — every other
//! platform simply doesn't offer the feature yet, handled by
//! `commands::drag_out::drag_out_start`'s `#[cfg(not(windows))]` branch.
#[cfg(windows)]
mod manifest;
#[cfg(windows)]
pub mod windows;

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
