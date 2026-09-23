//! Connection lifecycle commands: IPC in, IPC out.
//!
//! The pipeline itself lives in `application::session_service`. What is left
//! here is the translation — validating the incoming config, and shaping the
//! service's outcome into the response the renderer expects.

use crate::application::session_service;
use crate::domain::ConnectionConfig as IpcConnectionConfig;
use crate::ipc::{CommandError, CommandResult, OkResult};
use crate::runtime::log_emitter::LogEmitter;
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Sessions};
use crate::store::Store;
use serde::Serialize;
use tauri::State;

/// The host key the connection refused, and what the user has to decide
/// about: keep the pinned fingerprint, or trust this one instead. `expected`
/// is absent on a first connection, which is the same decision with nothing
/// to compare against yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyMismatchPayload {
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    pub actual: String,
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
        &log_emitter,
        &store,
        &vault,
        &connection_id,
        config.into_map(),
    )
    .await;

    if let Some(slot) = sessions.get_existing(&connection_id) {
        sessions.remove_if_empty(&connection_id, &slot);
    }

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
                    expected: mismatch.expected,
                    actual: mismatch.actual,
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

/// Trusts one exact host key for one exact server.
///
/// This replaced an unconditional "forget the pinned key": a renderer could
/// delete the pin and reconnect, and the next key it was offered became the
/// new first sighting. The grant is issued by the backend's own confirmation
/// window, which shows both fingerprints, and it is bound to all four values,
/// so it cannot be spent on another server or another pair of keys. The write
/// is a compare-and-swap, so a pin that moved on in between makes the
/// decision stale rather than silently overwriting it.
#[tauri::command]
pub async fn session_trust_host_key(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    store: State<'_, Store>,
    request: String,
) -> CommandResult<OkResult> {
    let parsed = crate::security::sensitive::host_key_from_request(&request)?;
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "session_trust_host_key",
        &request,
    )?;
    match store
        .trust_known_host_fingerprint(
            &parsed.host,
            parsed.port,
            parsed.expected.as_deref(),
            &parsed.actual,
        )
        .await
    {
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
                expected: Some("aa".into()),
                actual: "bb".into(),
            }),
        })
        .unwrap();
        assert!(
            value.get("hostKeyMismatch").is_some(),
            "expected hostKeyMismatch, got {value}"
        );
    }
}
