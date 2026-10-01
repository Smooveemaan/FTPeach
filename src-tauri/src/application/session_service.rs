//! Resolves connection settings, opens the browse client and transfer pool,
//! and tears both down on disconnect or connection failure.

use crate::domain::{
    ConnectRequest, Credentials, Protocol, ServerSettings, WindowConnectionSettings,
    invalid_connection_settings,
};
use crate::ipc::{CommandError, ErrorCode};
use crate::protocol::config::ConnectionConfig;
use crate::protocol::sftp::HostKeyMismatchError;
use crate::protocol::{ftp::FtpBackend, sftp::SftpBackend, webdav::WebDavBackend};
use crate::runtime::log_emitter::LogEmitter;
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Session, Sessions, TEARDOWN_DEADLINE, teardown_session};
use crate::store::Store;
use crate::transfer::transfer_pool::{BoxBackend, PoolSize, TransferPool};
use std::sync::Arc;

/// The host whose key the connection would not accept, when that is why a
/// connect failed. The command layer turns this into the payload the
/// renderer needs to ask the user to trust this exact fingerprint.
pub(crate) struct HostKeyMismatch {
    pub host: String,
    pub port: u16,
    /// The pinned fingerprint, or `None` on a first sighting.
    pub expected: Option<String>,
    pub actual: String,
}

pub(crate) struct ConnectFailure {
    pub error: CommandError,
    pub host_key_mismatch: Option<HostKeyMismatch>,
}

impl ConnectFailure {
    fn from_error(error: CommandError) -> Self {
        Self {
            error,
            host_key_mismatch: None,
        }
    }
}

/// Builds a backend whose log lines go to the protocol log under
/// `connection_id`, named as `server_label` in the file and the diagnostic
/// bundle.
pub(crate) fn create_backend(
    protocol: Protocol,
    connection_id: &str,
    server_label: &str,
    log_emitter: &LogEmitter,
    store: &Store,
) -> BoxBackend {
    let mut backend: BoxBackend = match protocol {
        Protocol::Sftp => Box::new(SftpBackend::new(Arc::new(store.clone()))),
        Protocol::Webdav => Box::new(WebDavBackend::new()),
        Protocol::Ftp | Protocol::Ftps => Box::new(FtpBackend::new()),
    };
    let emitter = log_emitter.clone();
    let connection_id = connection_id.to_string();
    let server_label = server_label.to_string();
    backend.set_log_sink(Some(Arc::new(move |text, kind| {
        emitter.push(text, kind, &connection_id, &server_label);
    })));
    backend
}

/// The transfer pool grows with demand. A site's connection limit caps it,
/// leaving one connection for browsing.
fn pool_size(max_connections: Option<u16>) -> PoolSize {
    match max_connections {
        Some(limit) if limit >= 2 => PoolSize::Capped(usize::from(limit - 1)),
        _ => PoolSize::Unlimited,
    }
}

/// The server a request names and the credentials to sign in with: the
/// request's own, or those of the saved site it names. A key or certificate
/// file a portable copy keeps relative to its folder is named in full here,
/// before anything checks or opens it.
pub(crate) async fn resolve_server(
    store: &Store,
    vault: &Vault,
    request: ConnectRequest,
) -> Result<(ServerSettings, Credentials), CommandError> {
    let (mut server, credentials) = match request {
        ConnectRequest::Direct {
            server,
            credentials,
        } => (server, credentials),
        ConnectRequest::SavedSite { site_id } => store
            .saved_server(&site_id, vault)
            .await
            .map_err(|error| CommandError::from_anyhow(&error))?,
    };
    let root = crate::local_fs::portable::root();
    for path in [&mut server.key_path, &mut server.ca_cert_path] {
        *path = crate::local_fs::portable::resolved_path(path, root);
    }
    Ok((server, credentials))
}

/// The configuration the protocol backend connects with: the server and its
/// credentials, and the connection settings of the application and the
/// window.
pub(crate) async fn connection_config(
    store: &Store,
    vault: &Vault,
    server: &ServerSettings,
    credentials: Credentials,
    window: WindowConnectionSettings,
) -> Result<ConnectionConfig, CommandError> {
    let defaults = store
        .connection_defaults(vault, window)
        .await
        .map_err(|error| CommandError::from_anyhow(&error))?;
    ConnectionConfig::build(server, credentials, &defaults)
        .map_err(|error| invalid_connection_settings(&error))
}

/// How many connections may be open, or waiting to open, at once.
///
/// Two panes per tab and a handful of tabs is the shape of ordinary use; the
/// rest of this number is headroom. What it bounds is a renderer that asks
/// for a slot per invented connection id.
const MAX_SESSIONS: usize = 64;

/// Opens a session for `connection_id`, replacing whatever occupied the slot.
///
/// Holds the slot lock for the whole pipeline, so a second connect for the
/// same id waits rather than racing. Cancellation goes through
/// `ConnectingClients`, which lets a disconnect abandon a stalled connect
/// without waiting for the lock.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect(
    sessions: &Sessions,
    connecting: &ConnectingClients,
    log_emitter: &LogEmitter,
    store: &Store,
    vault: &Vault,
    connection_id: &str,
    server: &ServerSettings,
    credentials: Credentials,
    window: WindowConnectionSettings,
) -> Result<(), ConnectFailure> {
    if !sessions.has_slot(connection_id) && sessions.slot_count() >= MAX_SESSIONS {
        return Err(ConnectFailure::from_error(CommandError::new(
            ErrorCode::ResourceLimit,
            "Too many connections are open",
        )));
    }
    let slot = sessions.get_or_create(connection_id);
    let mut guard = slot.lock().await;
    teardown_session(&mut guard, connection_id, Some(TEARDOWN_DEADLINE)).await;

    let typed_config = connection_config(store, vault, server, credentials, window)
        .await
        .map_err(ConnectFailure::from_error)?;
    let protocol = typed_config.protocol();
    let browse_timeout_ms = typed_config.common().timeout_ms;
    let server = typed_config.server();
    let server_label = typed_config.log_label();
    let origin_base = server_label.clone();

    let token = connecting.start(connection_id);
    let mut browse_client =
        create_backend(protocol, connection_id, &server_label, log_emitter, store);
    let connect_result = tokio::select! {
        res = browse_client.connect(&typed_config) => res,
        _ = token.cancelled() => Err(CommandError::new(ErrorCode::Cancelled, "Operation cancelled").into()),
    };
    connecting.finish(connection_id);

    if let Err(error) = connect_result {
        let _ = browse_client.disconnect().await;
        return Err(ConnectFailure {
            host_key_mismatch: error
                .chain()
                .find_map(|cause| cause.downcast_ref::<HostKeyMismatchError>())
                .map(|mismatch| HostKeyMismatch {
                    host: mismatch.host.clone(),
                    port: mismatch.port,
                    expected: mismatch.expected.clone(),
                    actual: mismatch.actual.clone(),
                }),
            error: CommandError::from_anyhow(&error),
        });
    }

    let pool_size = pool_size(typed_config.common().max_connections);
    let pool_protocol = protocol;
    let pool_connection_id = connection_id.to_string();
    let pool_config = typed_config.clone();
    let log_emitter_handle = log_emitter.clone();
    let store_handle = store.clone();
    let factory: crate::transfer::transfer_pool::BackendFactory = Arc::new(move || {
        let protocol = pool_protocol;
        let connection_id = pool_connection_id.clone();
        let config = pool_config.clone();
        let server_label = server_label.clone();
        let log_emitter = log_emitter_handle.clone();
        let store = store_handle.clone();
        Box::pin(async move {
            let mut backend = create_backend(
                protocol,
                &connection_id,
                &server_label,
                &log_emitter,
                &store,
            );
            backend.connect(&config).await?;
            Ok(backend)
        })
    });

    let transfer_pool = TransferPool::new(factory, pool_size)
        .with_limiter(crate::transfer::concurrency_limiter::shared());
    if !sessions.register_pool(connection_id, &slot, transfer_pool.clone()) {
        transfer_pool.cancel_all();
        return Err(ConnectFailure::from_error(CommandError::new(
            ErrorCode::Cancelled,
            "Connection closed during setup",
        )));
    }
    *guard = Some(Session {
        browse_client,
        server,
        origin_base,
        transfer_pool,
        browse_timeout_ms,
    });
    Ok(())
}

/// Cancels any in-flight connect, closes the session, and drops the slot once
/// nothing else holds it.
pub(crate) async fn disconnect(
    sessions: &Sessions,
    connecting: &ConnectingClients,
    connection_id: &str,
) {
    connecting.cancel(connection_id);
    crate::application::recursive_transfer::close_connection(connection_id);
    let Some(slot) = sessions.remove(connection_id) else {
        return;
    };
    // One deadline for the wait on the slot and the teardown together: a
    // browse call that still holds the slot must not make this take longer.
    let closing = async {
        let mut guard = slot.lock().await;
        teardown_session(&mut guard, connection_id, None).await;
    };
    if tokio::time::timeout(TEARDOWN_DEADLINE, closing)
        .await
        .is_err()
    {
        log::warn!("Disconnect deadline exceeded for {connection_id}; session detached");
        crate::transfer::upload_staging::retain_for_connection(connection_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_limit_leaves_one_connection_for_browsing() {
        assert!(matches!(pool_size(Some(5)), PoolSize::Capped(4)));
        assert!(matches!(pool_size(Some(2)), PoolSize::Capped(1)));
        assert!(matches!(pool_size(Some(0)), PoolSize::Unlimited));
        assert!(matches!(pool_size(None), PoolSize::Unlimited));
    }
}
