//! Interactive SSH terminal IPC commands.
//!
//! Only the main window may invoke these commands. Terminal input and output
//! are never logged.

use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::session::Sessions;
use crate::terminal::{TerminalEvent, TerminalOpenOutcome, Terminals};
use std::sync::Arc;
use tauri::{State, WebviewWindow, ipc::Channel};

fn require_main_window(window: &WebviewWindow) -> CommandResult<()> {
    if window.label() != "main" {
        return Err(CommandError::new(
            ErrorCode::PermissionDenied,
            "Terminal commands are restricted to the main window",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_open(
    window: WebviewWindow,
    sessions: State<'_, Sessions>,
    terminals: State<'_, Terminals>,
    connection_id: String,
    cols: u32,
    rows: u32,
    on_event: Channel<TerminalEvent>,
) -> CommandResult<TerminalOpenOutcome> {
    require_main_window(&window)?;
    let ssh = sessions.ssh_handle_for(&connection_id).ok_or_else(|| {
        CommandError::new(
            ErrorCode::InvalidInput,
            "SSH terminal requires an active SFTP connection",
        )
    })?;
    let sink = Arc::new(move |event: TerminalEvent| {
        on_event.send(event).map_err(|error| error.to_string())
    });
    terminals.open(&connection_id, ssh, cols, rows, sink).await
}

#[tauri::command]
pub async fn terminal_write(
    window: WebviewWindow,
    terminals: State<'_, Terminals>,
    terminal_id: String,
    data: String,
) -> CommandResult<()> {
    require_main_window(&window)?;
    terminals.write(&terminal_id, data.into_bytes()).await
}

#[tauri::command]
pub async fn terminal_resize(
    window: WebviewWindow,
    terminals: State<'_, Terminals>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> CommandResult<()> {
    require_main_window(&window)?;
    terminals.resize(&terminal_id, cols, rows).await
}

#[tauri::command]
pub fn terminal_ack(
    window: WebviewWindow,
    terminals: State<'_, Terminals>,
    terminal_id: String,
    bytes: usize,
) -> CommandResult<()> {
    require_main_window(&window)?;
    terminals.ack(&terminal_id, bytes)
}

#[tauri::command]
pub fn terminal_close(
    window: WebviewWindow,
    terminals: State<'_, Terminals>,
    terminal_id: String,
) -> CommandResult<()> {
    require_main_window(&window)?;
    terminals.close(&terminal_id)
}
