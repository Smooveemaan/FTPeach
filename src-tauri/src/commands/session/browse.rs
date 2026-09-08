use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION, OkResult};
use crate::protocol::EntryInfo;
use crate::session::{ConnectingClients, Sessions, teardown_session};
use tauri::State;

const UNSAFE_PATH_MSG: &str = "Path must not contain carriage return or newline characters";
const BROWSE_TIMEOUT_MSG: &str = "Server response timed out. Connection dropped.";

/// FTP/WebDAV build wire commands by interpolating paths directly. Rejecting
/// CR/LF here prevents a renderer-provided path from injecting a second
/// command into the same control channel or request.
fn is_safe_path(path: &str) -> bool {
    crate::security::connection_guard::is_safe_remote_path_argument(path)
}

enum BrowseOutcome<T> {
    Completed(crate::protocol::BackendResult<T>),
    TimedOut,
    Cancelled,
}

async fn with_browse_timeout<T>(
    timeout_ms: u64,
    token: &tokio_util::sync::CancellationToken,
    fut: impl std::future::Future<Output = crate::protocol::BackendResult<T>>,
) -> BrowseOutcome<T> {
    tokio::pin!(fut);
    if timeout_ms == 0 {
        return tokio::select! {
            res = &mut fut => BrowseOutcome::Completed(res),
            _ = token.cancelled() => BrowseOutcome::Cancelled,
        };
    }
    tokio::select! {
        res = &mut fut => BrowseOutcome::Completed(res),
        _ = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)) => BrowseOutcome::TimedOut,
        _ = token.cancelled() => BrowseOutcome::Cancelled,
    }
}

#[derive(serde::Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum SessionListResult {
    Ok { ok: bool, entries: Vec<EntryInfo> },
    Err { ok: bool, error: CommandError },
}

#[tauri::command]
pub async fn session_list(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
    remote_path: Option<String>,
) -> CommandResult<SessionListResult> {
    if let Some(path) = remote_path.as_deref()
        && let Err(error) = crate::protocol::validate_remote_path(path)
    {
        return Ok(SessionListResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&error),
        });
    }
    if !remote_path.as_deref().is_none_or(is_safe_path) {
        return Ok(SessionListResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, UNSAFE_PATH_MSG),
        });
    }
    let slot = sessions.slot_for(&connection_id);
    let mut guard = slot.lock().await;
    let Some(session) = guard.as_mut() else {
        return Ok(SessionListResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };
    let timeout_ms = session.browse_timeout_ms;
    let token = connecting.start(&connection_id);
    let outcome = with_browse_timeout(
        timeout_ms,
        &token,
        session
            .browse_client
            .list(remote_path.as_deref().unwrap_or("/")),
    )
    .await;
    connecting.finish(&connection_id);
    let result = match outcome {
        BrowseOutcome::Completed(Ok(entries)) => {
            match crate::protocol::validate_listing(&entries) {
                Ok(()) => Ok(SessionListResult::Ok { ok: true, entries }),
                Err(error) => Ok(SessionListResult::Err {
                    ok: false,
                    error: CommandError::from_anyhow(&error),
                }),
            }
        }
        BrowseOutcome::Completed(Err(err)) => Ok(SessionListResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&err),
        }),
        BrowseOutcome::TimedOut => {
            teardown_session(&mut guard).await;
            Ok(SessionListResult::Err {
                ok: false,
                error: CommandError::new(ErrorCode::TimedOut, BROWSE_TIMEOUT_MSG),
            })
        }
        BrowseOutcome::Cancelled => {
            teardown_session(&mut guard).await;
            Ok(SessionListResult::Err {
                ok: false,
                error: CommandError::new(ErrorCode::Cancelled, "Operation cancelled"),
            })
        }
    };
    drop(guard);
    sessions.remove_if_empty(&connection_id, &slot);
    result
}

macro_rules! run_unit_browse_operation {
    ($sessions:expr_2021, $connecting:expr_2021, $connection_id:expr_2021, $method:ident $(, $argument:expr_2021)* $(,)?) => {{
        let slot = $sessions.slot_for(&$connection_id);
        let mut guard = slot.lock().await;
        let Some(session) = guard.as_mut() else {
            return Ok(OkResult::Err {
                ok: false,
                error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
            });
        };
        let timeout_ms = session.browse_timeout_ms;
        let token = $connecting.start(&$connection_id);
        let outcome = with_browse_timeout(
            timeout_ms,
            &token,
            session.browse_client.$method($($argument),*),
        )
        .await;
        $connecting.finish(&$connection_id);
        let result = match outcome {
            BrowseOutcome::Completed(Ok(())) => Ok(OkResult::Ok { ok: true }),
            BrowseOutcome::Completed(Err(err)) => Ok(OkResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&err),
            }),
            BrowseOutcome::TimedOut => {
                teardown_session(&mut guard).await;
                Ok(OkResult::Err {
                    ok: false,
                    error: CommandError::new(ErrorCode::TimedOut, BROWSE_TIMEOUT_MSG),
                })
            }
            BrowseOutcome::Cancelled => {
                teardown_session(&mut guard).await;
                Ok(OkResult::Err {
                    ok: false,
                    error: CommandError::new(ErrorCode::Cancelled, "Operation cancelled"),
                })
            }
        };
        drop(guard);
        $sessions.remove_if_empty(&$connection_id, &slot);
        result
    }};
}

fn invalid_path_result() -> CommandResult<OkResult> {
    Ok(OkResult::Err {
        ok: false,
        error: CommandError::new(ErrorCode::InvalidInput, UNSAFE_PATH_MSG),
    })
}

#[tauri::command]
pub async fn session_mkdir(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
    remote_path: String,
) -> CommandResult<OkResult> {
    if !is_safe_path(&remote_path) {
        return invalid_path_result();
    }
    let _target = crate::local_fs::target_reservation::Reservation::acquire(&remote_path)
        .map_err(CommandError::from)?;
    run_unit_browse_operation!(sessions, connecting, connection_id, mkdir, &remote_path)
}

#[tauri::command]
pub async fn session_create_file(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
    remote_path: String,
) -> CommandResult<OkResult> {
    if !is_safe_path(&remote_path) {
        return invalid_path_result();
    }
    let _target = crate::local_fs::target_reservation::Reservation::acquire(&remote_path)
        .map_err(CommandError::from)?;
    run_unit_browse_operation!(
        sessions,
        connecting,
        connection_id,
        create_file,
        &remote_path
    )
}

#[tauri::command]
pub async fn session_delete(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
    remote_path: String,
    is_dir: bool,
) -> CommandResult<OkResult> {
    if !is_safe_path(&remote_path) {
        return invalid_path_result();
    }
    let _target = crate::local_fs::target_reservation::Reservation::acquire(&remote_path)
        .map_err(CommandError::from)?;
    run_unit_browse_operation!(
        sessions,
        connecting,
        connection_id,
        remove,
        &remote_path,
        is_dir
    )
}

#[tauri::command]
pub async fn session_rename(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
    old_path: String,
    new_path: String,
    overwrite: Option<bool>,
) -> CommandResult<OkResult> {
    if !is_safe_path(&old_path) || !is_safe_path(&new_path) {
        return invalid_path_result();
    }
    if let Err(error) = crate::protocol::validate_remote_relationship(&old_path, &new_path) {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&error),
        });
    }
    let _source = crate::local_fs::target_reservation::Reservation::acquire(&old_path)
        .map_err(CommandError::from)?;
    let _target = crate::local_fs::target_reservation::Reservation::acquire(&new_path)
        .map_err(CommandError::from)?;
    if overwrite == Some(false) {
        return run_unit_browse_operation!(
            sessions,
            connecting,
            connection_id,
            rename_no_replace,
            &old_path,
            &new_path
        );
    }
    run_unit_browse_operation!(
        sessions,
        connecting,
        connection_id,
        rename,
        &old_path,
        &new_path,
    )
}

#[tauri::command]
pub async fn session_chmod(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
    remote_path: String,
    mode: String,
) -> CommandResult<OkResult> {
    let mode = match parse_permission_mode(&mode) {
        Some(mode) => mode,
        None => {
            return Ok(OkResult::Err {
                ok: false,
                error: CommandError::new(
                    ErrorCode::InvalidInput,
                    "Permission mode must be an octal value from 0000 to 7777",
                ),
            });
        }
    };
    if !is_safe_path(&remote_path) {
        return invalid_path_result();
    }
    run_unit_browse_operation!(
        sessions,
        connecting,
        connection_id,
        chmod,
        &remote_path,
        mode
    )
}

fn parse_permission_mode(value: &str) -> Option<u32> {
    let trimmed = value.trim();
    if !(3..=4).contains(&trimmed.len()) {
        return None;
    }
    u32::from_str_radix(trimmed, 8)
        .ok()
        .filter(|mode| *mode <= 0o7777)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_accepts_only_three_or_four_octal_digits() {
        assert_eq!(parse_permission_mode("644"), Some(0o644));
        assert_eq!(parse_permission_mode(" 0755 "), Some(0o755));
        assert_eq!(parse_permission_mode("88"), None);
        assert_eq!(parse_permission_mode("10000"), None);
    }
}
