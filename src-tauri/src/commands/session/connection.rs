//! Connection lifecycle commands: IPC in, IPC out.
//!
//! The pipeline itself lives in `application::session_service`. What is left
//! here is the translation — validating the incoming config, and shaping the
//! service's outcome into the response the renderer expects.

use crate::application::session_service;
use crate::domain::ConnectionConfig as IpcConnectionConfig;
use crate::ipc::{CommandError, CommandResult, OkResult};
use crate::runtime::log_emitter::{LogEmitter, LogState};
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Sessions};
use crate::store::Store;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyMismatchPayload {
    pub host: String,
    pub port: u16,
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum SessionConnectResult {
    Ok {
        ok: bool,
    },
    #[serde(rename_all = "camelCase")]
    Err {
        ok: bool,
        error: CommandError,
        #[serde(skip_serializing_if = "Option::is_none")]
        host_key_mismatch: Option<HostKeyMismatchPayload>,
    },
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_connect(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    log_state: State<'_, LogState>,
    log_emitter: State<'_, LogEmitter>,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    connection_id: String,
    config: IpcConnectionConfig,
) -> Result<SessionConnectResult, CommandError> {
    config.validate()?;
    let outcome = session_service::connect(
        &sessions,
        &connecting,
        &log_state,
        &log_emitter,
        &store,
        &vault,
        &connection_id,
        config.into_map(),
    )
    .await;

    Ok(match outcome {
        Ok(()) => SessionConnectResult::Ok { ok: true },
        Err(failure) => SessionConnectResult::Err {
            ok: false,
            error: failure.error,
            host_key_mismatch: failure
                .host_key_mismatch
                .map(|mismatch| HostKeyMismatchPayload {
                    host: mismatch.host,
                    port: mismatch.port,
                }),
        },
    })
}

#[tauri::command]
pub async fn session_cancel_connect(
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
) -> CommandResult<OkResult> {
    Ok(OkResult::Ok {
        ok: connecting.cancel(&connection_id),
    })
}

#[tauri::command]
pub async fn session_disconnect(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
) -> CommandResult<OkResult> {
    session_service::disconnect(&sessions, &connecting, &connection_id).await;
    Ok(OkResult::Ok { ok: true })
}

#[tauri::command]
pub async fn session_forget_host_key(
    store: State<'_, Store>,
    host: String,
    port: u16,
) -> CommandResult<OkResult> {
    match store.forget_known_host_fingerprint(&host, port).await {
        Ok(()) => Ok(OkResult::Ok { ok: true }),
        Err(err) => Ok(OkResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&err),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_err_host_key_mismatch_is_camel_case() {
        let value = serde_json::to_value(SessionConnectResult::Err {
            ok: false,
            error: CommandError::new(crate::ipc::ErrorCode::HostKeyMismatch, "mismatch"),
            host_key_mismatch: Some(HostKeyMismatchPayload {
                host: "h".into(),
                port: 22,
            }),
        })
        .unwrap();
        assert!(
            value.get("hostKeyMismatch").is_some(),
            "expected hostKeyMismatch, got {value}"
        );
    }
}
