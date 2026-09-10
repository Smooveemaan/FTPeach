use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION};
use crate::native_drag::DragOutFile;
use crate::session::Sessions;
use crate::transfer::progress::ProgressEmitter;
use serde::Serialize;
use tauri::{AppHandle, State, Window};

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum DragOutStartResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        ok: bool,
    },
    Err {
        ok: bool,
        error: CommandError,
    },
}

/// Starts a native OS drag-and-drop session for one or more remote files,
/// letting the user drop them onto Explorer (or any other drop target) to
/// download them. Unlike a plain "download to a temp path first" approach,
/// the actual transfer is lazy: the OS only pulls bytes from us once the
/// drop target asks for them (see `native_drag::windows`), which is required
/// for the native drag to work at all — `DoDragDrop` must be entered while
/// the mouse button is still physically held, and any async work (like a
/// download) attempted first almost always loses that race.
///
/// Resolves once the drag gesture itself completes (dropped or cancelled);
/// the download a drop triggers keeps running in the background after that
/// and shows up in the Transfers panel like any other transfer, which is
/// what `protocol` is for (the row needs one, and this side doesn't
/// otherwise know it).
#[tauri::command]
pub async fn drag_out_start(
    window: Window,
    app: AppHandle,
    sessions: State<'_, Sessions>,
    progress: State<'_, ProgressEmitter>,
    connection_id: String,
    protocol: String,
    files: Vec<DragOutFile>,
) -> CommandResult<DragOutStartResult> {
    if files.is_empty() {
        return Ok(DragOutStartResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, "No files to drag"),
        });
    }
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Ok(DragOutStartResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };

    #[cfg(windows)]
    {
        let reporter = crate::native_drag::windows::TransferReporter::new(
            app,
            progress.inner().clone(),
            connection_id,
            protocol,
        );
        match crate::native_drag::windows::start_drag(window, reporter, pool, files).await {
            Ok(()) => Ok(DragOutStartResult::Ok { ok: true }),
            Err(err) => Ok(DragOutStartResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&err),
            }),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, app, progress, pool, connection_id, protocol, files);
        Ok(DragOutStartResult::Err {
            ok: false,
            error: CommandError::new(
                ErrorCode::InvalidInput,
                "Dragging files out to the OS file explorer isn't supported on this platform yet",
            ),
        })
    }
}

/// Starts a native OS drag-and-drop session for files that already exist on
/// disk, so a local pane's selection can be dropped onto Explorer, the
/// desktop, or any other drop target. Nothing is transferred through us —
/// the shell copies the paths itself — so unlike `drag_out_start` there is
/// no session, no lazy download and no Transfers row.
///
/// Resolves once the drag gesture completes (dropped or cancelled).
#[tauri::command]
pub async fn drag_out_start_local(
    window: Window,
    paths: Vec<String>,
) -> CommandResult<DragOutStartResult> {
    if paths.is_empty() {
        return Ok(DragOutStartResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, "No files to drag"),
        });
    }

    #[cfg(windows)]
    {
        match crate::native_drag::windows::start_local_drag(window, paths).await {
            Ok(()) => Ok(DragOutStartResult::Ok { ok: true }),
            Err(err) => Ok(DragOutStartResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&err),
            }),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths);
        Ok(DragOutStartResult::Err {
            ok: false,
            error: CommandError::new(
                ErrorCode::InvalidInput,
                "Dragging files out to the OS file explorer isn't supported on this platform yet",
            ),
        })
    }
}

// See commands/preview.rs's serde_field_casing module for why this needs
// its own per-variant rename_all and a test guarding it.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_result_is_camel_case() {
        let value = serde_json::to_value(DragOutStartResult::Ok { ok: true }).unwrap();
        assert_eq!(value["result"], "ok");
        assert_eq!(value["ok"], true);
    }
}
