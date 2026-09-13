use crate::protocol::ProtocolBackend;
use crate::transfer::transfer_pool::TransferPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub struct Session {
    pub browse_client: Box<dyn ProtocolBackend + Send>,
    /// The server this session is connected to, as
    /// [`crate::protocol::config::ConnectionConfig::server`] names it.
    pub server: String,
    pub transfer_pool: TransferPool,
    pub browse_timeout_ms: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.transfer_pool.cancel_all();
    }
}

pub type SessionSlot = Arc<AsyncMutex<Option<Session>>>;

/// A lookup releases a formerly occupied/connecting slot on every exit path.
pub struct SessionLookup {
    slot: SessionSlot,
    sessions: Sessions,
    id: String,
}
impl std::ops::Deref for SessionLookup {
    type Target = SessionSlot;
    fn deref(&self) -> &Self::Target {
        &self.slot
    }
}
impl Drop for SessionLookup {
    fn drop(&mut self) {
        self.sessions.remove_if_empty(&self.id, &self.slot);
    }
}

#[derive(Clone, Default)]
pub struct Sessions {
    inner: Arc<StdMutex<HashMap<String, SessionSlot>>>,
    pools: Arc<StdMutex<HashMap<String, TransferPool>>>,
}

impl Sessions {
    pub fn remove(&self, connection_id: &str) -> Option<SessionSlot> {
        let mut map = self.inner.lock().unwrap();
        let slot = map.remove(connection_id);
        let pool = self.pools.lock().unwrap().remove(connection_id);
        drop(map);
        if let Some(pool) = pool {
            pool.cancel_all();
        }
        slot
    }

    /// Keep cancellation reachable even while a browse operation holds the slot.
    pub fn register_pool(
        &self,
        connection_id: &str,
        slot: &SessionSlot,
        pool: TransferPool,
    ) -> bool {
        let map = self.inner.lock().unwrap();
        if !map
            .get(connection_id)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            return false;
        }
        self.pools
            .lock()
            .unwrap()
            .insert(connection_id.to_owned(), pool);
        true
    }
    pub fn get_existing(&self, connection_id: &str) -> Option<SessionSlot> {
        self.inner.lock().unwrap().get(connection_id).cloned()
    }

    /// Missing reads use a detached empty slot; they never register a session.
    pub fn lookup_slot(&self, connection_id: &str) -> SessionLookup {
        SessionLookup {
            slot: self.get_existing(connection_id).unwrap_or_default(),
            sessions: self.clone(),
            id: connection_id.to_owned(),
        }
    }

    pub fn slot_for(&self, connection_id: &str) -> SessionSlot {
        let mut map = self.inner.lock().unwrap();
        map.entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    }

    pub fn get_or_create(&self, connection_id: &str) -> SessionLookup {
        SessionLookup {
            slot: self.slot_for(connection_id),
            sessions: self.clone(),
            id: connection_id.to_owned(),
        }
    }

    /// The transfer pool of a live session, or `None` if there is none.
    /// A lookup on the slot map, so it lives with the map rather than inside
    /// whichever Tauri command needed it first.
    pub async fn pool_for(&self, connection_id: &str) -> Option<TransferPool> {
        if let Some(pool) = self.pools.lock().unwrap().get(connection_id).cloned() {
            return Some(pool);
        }
        let slot = self.lookup_slot(connection_id);
        let guard = slot.lock().await;
        guard.as_ref().map(|session| session.transfer_pool.clone())
    }

    /// The server a live session is connected to. With no session there is
    /// nothing to tell its server by, so the connection stands in for it.
    pub async fn server_for(&self, connection_id: &str) -> String {
        let slot = self.lookup_slot(connection_id);
        let guard = slot.lock().await;
        guard.as_ref().map_or_else(
            || connection_id.to_owned(),
            |session| session.server.clone(),
        )
    }

    /// Snapshot of every slot currently known, with the connection it belongs
    /// to — used only for cross-session sweeps (e.g. app shutdown), never for a
    /// single connectionId's operation (that always goes through `slot_for` +
    /// lock).
    pub fn all_slots(&self) -> Vec<(String, SessionSlot)> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect()
    }

    /// Removes an empty slot once the operation that owned it has released
    /// the async lock. Pointer identity and the strong count prevent an old
    /// teardown from deleting a replacement slot or one still used elsewhere.
    pub fn remove_if_empty(&self, connection_id: &str, slot: &SessionSlot) -> bool {
        let mut map = self.inner.lock().unwrap();
        let can_remove = map.get(connection_id).is_some_and(|current| {
            Arc::ptr_eq(current, slot)
                && Arc::strong_count(current) == 2
                && current.try_lock().is_ok_and(|guard| guard.is_none())
        });
        if can_remove {
            map.remove(connection_id);
            self.pools.lock().unwrap().remove(connection_id);
        }
        can_remove
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_lookups_do_not_allocate_slots() {
        let sessions = Sessions::default();
        for index in 0..10_000 {
            let id = index.to_string();
            assert!(sessions.pool_for(&id).await.is_none());
            assert_eq!(sessions.server_for(&id).await, id);
        }
        assert!(sessions.all_slots().is_empty());
    }

    #[tokio::test]
    async fn failed_creation_and_concurrent_empty_reads_release_registry() {
        let sessions = Sessions::default();
        for index in 0..10_000 {
            let id = index.to_string();
            let creating = sessions.get_or_create(&id);
            let reading = sessions.lookup_slot(&id);
            drop(creating);
            assert!(reading.lock().await.is_none());
            drop(reading);
        }
        assert!(sessions.all_slots().is_empty());
    }

    #[test]
    fn empty_slots_are_removed_only_after_other_users_release_them() {
        let sessions = Sessions::default();
        let slot = sessions.slot_for("connection");
        let concurrent_user = slot.clone();

        assert!(!sessions.remove_if_empty("connection", &slot));
        drop(concurrent_user);
        assert!(sessions.remove_if_empty("connection", &slot));
        assert!(sessions.all_slots().is_empty());
    }

    #[tokio::test]
    async fn disconnect_cancels_pool_without_waiting_for_browse_lock() {
        let sessions = Sessions::default();
        let slot = sessions.get_or_create("busy");
        let pool = TransferPool::new(
            Arc::new(|| Box::pin(async { Err(anyhow::anyhow!("factory must not run")) })),
            crate::transfer::transfer_pool::PoolSize::Fixed(1),
        );
        assert!(sessions.register_pool("busy", &slot, pool.clone()));
        let guard = slot.lock().await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                sessions.pool_for("busy")
            )
            .await
            .unwrap()
            .is_some()
        );
        sessions.remove("busy");
        assert!(sessions.all_slots().is_empty());
        assert!(sessions.pools.lock().unwrap().is_empty());
        let error = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            pool.run("late".into(), Box::new(|_| Box::pin(async { Ok(()) }))),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.to_string().contains("closed"));
        assert!(!sessions.register_pool("busy", &slot, pool));
        drop(guard);
    }

    #[tokio::test]
    async fn occupied_slots_are_not_removed() {
        let sessions = Sessions::default();
        let slot = sessions.slot_for("connection");
        let guard = slot.lock().await;

        assert!(!sessions.remove_if_empty("connection", &slot));
        drop(guard);
        assert!(sessions.remove_if_empty("connection", &slot));
    }
}

struct StagingRelease<'a>(&'a str);
impl Drop for StagingRelease<'_> {
    fn drop(&mut self) {
        crate::transfer::upload_staging::retain_for_connection(self.0);
    }
}

pub async fn teardown_session(slot: &mut Option<Session>, connection_id: &str) {
    if let Some(mut session) = slot.take() {
        let _staging = StagingRelease(connection_id);
        let closing = async {
            session.transfer_pool.destroy().await;
            session.transfer_pool.wait_until_idle().await;
            discard_paused_staging(&mut session, connection_id).await;
            let _ = session.browse_client.disconnect().await;
        };
        if tokio::time::timeout(std::time::Duration::from_secs(5), closing)
            .await
            .is_err()
        {
            log::warn!(
                "Session {connection_id} teardown deadline exceeded; remaining staging retained"
            );
        }
    }
}

/// Shutdown-specific ordering: cancel transfers first, wait for their tasks
/// to settle, then close the browsing connection. The outer coordinator owns
/// the hard timeout, so an uncooperative backend still cannot block exit.
pub async fn teardown_session_for_shutdown(slot: &mut Option<Session>, connection_id: &str) {
    if let Some(mut session) = slot.take() {
        let _staging = StagingRelease(connection_id);
        session.transfer_pool.destroy().await;
        session.transfer_pool.wait_until_idle().await;
        discard_paused_staging(&mut session, connection_id).await;
        let _ = session.browse_client.disconnect().await;
    }
}

/// A paused upload leaves a staging file on the server for its next attempt.
/// Once the session goes, that attempt can never come, so the file has to go
/// with it — and only while the connection can still reach it.
async fn discard_paused_staging(session: &mut Session, connection_id: &str) {
    crate::transfer::upload_staging::discard_for_connection(
        session.browse_client.as_mut(),
        connection_id,
    )
    .await;
}

#[derive(Clone, Default)]
pub struct ConnectingClients {
    inner: Arc<StdMutex<HashMap<String, CancellationToken>>>,
}

impl ConnectingClients {
    pub fn start(&self, connection_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.inner
            .lock()
            .unwrap()
            .insert(connection_id.to_string(), token.clone());
        token
    }

    pub fn finish(&self, connection_id: &str) {
        self.inner.lock().unwrap().remove(connection_id);
    }

    pub fn cancel(&self, connection_id: &str) -> bool {
        match self.inner.lock().unwrap().remove(connection_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) {
        let tokens: Vec<CancellationToken> =
            self.inner.lock().unwrap().drain().map(|(_, t)| t).collect();
        for token in tokens {
            token.cancel();
        }
    }
}
