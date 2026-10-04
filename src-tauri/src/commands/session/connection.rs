//! Connection lifecycle commands: IPC in, IPC out.
//!
//! The pipeline itself lives in `application::session_service`. What is left
//! here is the translation — refusing key and certificate files the user
//! never chose, and shaping the service's outcome into the response the
//! renderer expects.

use crate::application::session_service;
use crate::domain::{ConnectRequest, WindowConnectionSettings};
use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::runtime::log_emitter::LogEmitter;
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Sessions};
use crate::store::Store;
use serde::Serialize;
use tauri::State;

/// How a connect that did not fail ended. A host key the connection would
/// not accept on its own is not a failure but a decision for the user: keep
/// the pinned fingerprint, or trust this one instead. `expected` is absent on
/// a first connection, which is the same decision with nothing to compare
/// against yet.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum ConnectOutcome {
    Connected,
    #[serde(rename_all = "camelCase")]
    HostKeyUnconfirmed {
        host: String,
        port: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected: Option<String>,
        actual: String,
    },
}

impl ConnectOutcome {
    fn from_service(outcome: Result<(), session_service::ConnectFailure>) -> CommandResult<Self> {
        match outcome {
            Ok(()) => Ok(Self::Connected),
            Err(session_service::ConnectFailure {
                host_key_mismatch: Some(mismatch),
                ..
            }) => Ok(Self::HostKeyUnconfirmed {
                host: mismatch.host,
                port: mismatch.port,
                expected: mismatch.expected,
                actual: mismatch.actual,
            }),
            Err(failure) => Err(failure.error),
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_connect(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    log_emitter: State<'_, LogEmitter>,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    approved_paths: State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    connection_id: String,
    request: ConnectRequest,
    settings: WindowConnectionSettings,
) -> CommandResult<ConnectOutcome> {
    let (server, credentials) = session_service::resolve_server(&store, &vault, request).await?;
    // A private key or a CA bundle is read from disk by the protocol backend,
    // which has no way to ask about provenance. An address on a share the
    // user never chose is refused here, before the file is opened.
    for path in [&server.key_path, &server.ca_cert_path] {
        if !path.is_empty() {
            approved_paths.preflight(std::path::Path::new(path))?;
            if std::fs::metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(CommandError::new(
                    ErrorCode::CredentialFileMissing,
                    path.as_str(),
                ));
            }
        }
    }
    let outcome = session_service::connect(
        &sessions,
        &connecting,
        &log_emitter,
        &store,
        &vault,
        &connection_id,
        &server,
        credentials,
        settings,
    )
    .await;

    if let Some(slot) = sessions.get_existing(&connection_id) {
        sessions.remove_if_empty(&connection_id, &slot);
    }

    ConnectOutcome::from_service(outcome)
}

#[tauri::command]
pub async fn session_cancel_connect(
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
) -> CommandResult<()> {
    // Nothing connecting under this id is not a failure: there is nothing
    // left to stop.
    connecting.cancel(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn session_disconnect(
    sessions: State<'_, Sessions>,
    connecting: State<'_, ConnectingClients>,
    connection_id: String,
) -> CommandResult<()> {
    session_service::disconnect(&sessions, &connecting, &connection_id).await;
    Ok(())
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
) -> CommandResult<()> {
    let parsed = crate::security::sensitive::host_key_from_request(&request)?;
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "session_trust_host_key",
        &request,
    )?;
    Ok(store
        .trust_known_host_fingerprint(
            &parsed.host,
            parsed.port,
            parsed.expected.as_deref(),
            &parsed.actual,
        )
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::CommandError;

    fn failure(host_key: Option<(Option<&str>, &str)>) -> session_service::ConnectFailure {
        session_service::ConnectFailure {
            error: CommandError::new(crate::ipc::ErrorCode::HostKeyMismatch, "changed"),
            host_key_mismatch: host_key.map(|(expected, actual)| {
                Box::new(session_service::HostKeyMismatch {
                    host: "h".into(),
                    port: 22,
                    expected: expected.map(str::to_owned),
                    actual: actual.into(),
                })
            }),
        }
    }

    #[test]
    fn an_unconfirmed_host_key_is_an_outcome_the_renderer_decides_on() {
        let changed = ConnectOutcome::from_service(Err(failure(Some((Some("aa"), "bb"))))).unwrap();
        assert_eq!(
            serde_json::to_value(&changed).unwrap(),
            serde_json::json!({
                "outcome": "hostKeyUnconfirmed",
                "host": "h",
                "port": 22,
                "expected": "aa",
                "actual": "bb",
            })
        );
        let first = ConnectOutcome::from_service(Err(failure(Some((None, "bb"))))).unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::json!({ "outcome": "hostKeyUnconfirmed", "host": "h", "port": 22, "actual": "bb" })
        );
        assert_eq!(
            serde_json::to_value(ConnectOutcome::from_service(Ok(())).unwrap()).unwrap(),
            serde_json::json!({ "outcome": "connected" })
        );
    }

    #[test]
    fn any_other_connect_failure_rejects_with_its_error() {
        let error = ConnectOutcome::from_service(Err(failure(None))).unwrap_err();
        assert_eq!(error.code, crate::ipc::ErrorCode::HostKeyMismatch);
    }
}
