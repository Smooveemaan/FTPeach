//! Resolves connection settings, opens the browse client and transfer pool,
//! and tears both down on disconnect or connection failure.

use crate::domain::Protocol;
use crate::ipc::{CommandError, ErrorCode};
use crate::protocol::config::ConnectionConfig;
use crate::protocol::sftp::HostKeyMismatchError;
use crate::protocol::{ftp::FtpBackend, sftp::SftpBackend, webdav::WebDavBackend};
use crate::runtime::log_emitter::{LogEmitter, LogState};
use crate::security::vault::Vault;
use crate::session::{ConnectingClients, Session, Sessions, teardown_session};
use crate::store::{JsonMap, Store};
use crate::transfer::transfer_pool::{BoxBackend, PoolSize, TransferPool};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use zeroize::Zeroize;

/// A connection map that wipes its secret fields when dropped, so a failed
/// connect does not leave a password sitting in freed memory.
#[derive(Clone)]
struct SensitiveConnectionConfig(JsonMap);

impl SensitiveConnectionConfig {
    fn zeroize_secrets(&mut self) {
        for field in ["password", "keyPassphrase", "proxyPassword"] {
            if let Some(serde_json::Value::String(secret)) = self.0.get_mut(field) {
                secret.zeroize();
            }
        }
    }
}

impl std::ops::Deref for SensitiveConnectionConfig {
    type Target = JsonMap;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for SensitiveConnectionConfig {
    fn drop(&mut self) {
        self.zeroize_secrets();
    }
}

/// The host whose key stopped matching, when that is why a connect failed.
/// The command layer turns this into the payload the renderer needs to offer
/// the "forget this host key" recovery.
pub(crate) struct HostKeyMismatch {
    pub host: String,
    pub port: u16,
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

pub(crate) fn create_backend(
    protocol: Protocol,
    connection_id: &str,
    log_enabled: &Arc<AtomicBool>,
    log_emitter: &LogEmitter,
    store: &Store,
) -> BoxBackend {
    let mut backend: BoxBackend = match protocol {
        Protocol::Sftp => Box::new(SftpBackend::new(Arc::new(store.clone()))),
        Protocol::Webdav => Box::new(WebDavBackend::new()),
        Protocol::Ftp | Protocol::Ftps => Box::new(FtpBackend::new()),
    };
    backend.set_log_enabled(log_enabled.load(Ordering::Relaxed));
    let emitter = log_emitter.clone();
    let connection_id = connection_id.to_string();
    backend.set_log_sink(Some(Arc::new(move |text, kind| {
        emitter.push(text, kind, connection_id.clone());
    })));
    backend
}

/// Merges the saved site's stored configuration under the runtime one.
///
/// A connect that names a `siteId` takes its credentials from the vault, but
/// keeps the three fields the pane can override for this session.
async fn resolve_config(
    store: &Store,
    vault: &Vault,
    config: JsonMap,
) -> Result<JsonMap, CommandError> {
    let Some(site_id) = config
        .get("siteId")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
    else {
        return Ok(config);
    };
    let runtime_config = config;
    let mut config = store
        .connection_config_for_site_with_vault(&site_id, vault)
        .await
        .map_err(|error| CommandError::from_anyhow(&error))?;
    for key in ["concurrency", "timeout", "activeMode"] {
        if let Some(value) = runtime_config.get(key) {
            config.insert(key.into(), value.clone());
        }
    }
    Ok(config)
}

async fn pool_size_for(store: &Store, concurrency: Option<u16>) -> PoolSize {
    match concurrency {
        Some(0) => PoolSize::Unlimited,
        Some(n) => PoolSize::Fixed(n as usize),
        _ => {
            let settings = store.get_settings().await;
            let default_concurrency = settings
                .get("concurrency")
                .and_then(|v| v.as_u64())
                .unwrap_or(3) as usize;
            if default_concurrency == 0 {
                PoolSize::Unlimited
            } else {
                PoolSize::Fixed(default_concurrency)
            }
        }
    }
}

#[cfg(test)]
mod pool_settings_tests {
    use super::*;
    #[tokio::test]
    async fn global_zero_uses_unlimited_when_connection_has_no_override() {
        let root =
            std::env::temp_dir().join(format!("ftpeach-pool-setting-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(root.clone());
        store
            .set_settings(
                serde_json::json!({"concurrency":0,"connectTimeout":0})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .await
            .unwrap();
        assert!(matches!(
            pool_size_for(&store, None).await,
            PoolSize::Unlimited
        ));
        assert!(matches!(
            pool_size_for(&store, Some(1)).await,
            PoolSize::Fixed(1)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}

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
    log_state: &LogState,
    log_emitter: &LogEmitter,
    store: &Store,
    vault: &Vault,
    connection_id: &str,
    config: JsonMap,
) -> Result<(), ConnectFailure> {
    let slot = sessions.slot_for(connection_id);
    let mut guard = slot.lock().await;
    teardown_session(&mut guard).await;

    let mut config = resolve_config(store, vault, config)
        .await
        .map_err(ConnectFailure::from_error)?;
    for (key, value) in store.proxy_config_for_connect().await {
        config.insert(key, value);
    }

    let config = SensitiveConnectionConfig(config);
    let typed_config = ConnectionConfig::from_json_map(&config).map_err(|error| {
        ConnectFailure::from_error(CommandError {
            code: ErrorCode::InvalidInput,
            message: "Invalid connection configuration".into(),
            details: Some(format!("{error:#}")),
        })
    })?;
    let protocol = typed_config.protocol();
    let concurrency = typed_config.common().concurrency;
    let browse_timeout_ms = typed_config.common().timeout_ms;

    let token = connecting.start(connection_id);
    let mut browse_client = create_backend(
        protocol,
        connection_id,
        &log_state.enabled,
        log_emitter,
        store,
    );
    let connect_result = tokio::select! {
        res = browse_client.connect(&typed_config) => res,
        _ = token.cancelled() => Err(anyhow::anyhow!("Canceled by user")),
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
                }),
            error: CommandError::from_anyhow(&error),
        });
    }

    let pool_size = pool_size_for(store, concurrency).await;
    let pool_protocol = protocol;
    let pool_connection_id = connection_id.to_string();
    let pool_config = typed_config.clone();
    let log_enabled_handle = log_state.enabled.clone();
    let log_emitter_handle = log_emitter.clone();
    let store_handle = store.clone();
    let factory: crate::transfer::transfer_pool::BackendFactory = Arc::new(move || {
        let protocol = pool_protocol;
        let connection_id = pool_connection_id.clone();
        let config = pool_config.clone();
        let log_enabled = log_enabled_handle.clone();
        let log_emitter = log_emitter_handle.clone();
        let store = store_handle.clone();
        Box::pin(async move {
            let mut backend =
                create_backend(protocol, &connection_id, &log_enabled, &log_emitter, &store);
            backend.connect(&config).await?;
            Ok(backend)
        })
    });

    *guard = Some(Session {
        browse_client,
        transfer_pool: TransferPool::new(factory, pool_size),
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
    let slot = sessions.slot_for(connection_id);
    let mut guard = slot.lock().await;
    teardown_session(&mut guard).await;
    drop(guard);
    sessions.remove_if_empty(connection_id, &slot);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_config_zeroizes_all_secret_fields() {
        let mut values = JsonMap::new();
        values.insert("host".into(), serde_json::json!("example.test"));
        values.insert("password".into(), serde_json::json!("password"));
        values.insert("keyPassphrase".into(), serde_json::json!("passphrase"));
        values.insert("proxyPassword".into(), serde_json::json!("proxy-password"));
        let mut config = SensitiveConnectionConfig(values);

        config.zeroize_secrets();

        assert_eq!(
            config.get("host").and_then(|value| value.as_str()),
            Some("example.test")
        );
        for field in ["password", "keyPassphrase", "proxyPassword"] {
            assert_eq!(config.get(field).and_then(|value| value.as_str()), Some(""));
        }
    }
}
