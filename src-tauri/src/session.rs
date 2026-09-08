use crate::protocol::ProtocolBackend;
use crate::transfer::transfer_pool::TransferPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub struct Session {
    pub browse_client: Box<dyn ProtocolBackend + Send>,
    pub transfer_pool: TransferPool,
    pub browse_timeout_ms: u64,
}

pub type SessionSlot = Arc<AsyncMutex<Option<Session>>>;

#[derive(Clone, Default)]
pub struct Sessions {
    inner: Arc<StdMutex<HashMap<String, SessionSlot>>>,
}

impl Sessions {
    pub fn slot_for(&self, connection_id: &str) -> SessionSlot {
        let mut map = self.inner.lock().unwrap();
        map.entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    }

    /// The transfer pool of a live session, or `None` if there is none.
    /// A lookup on the slot map, so it lives with the map rather than inside
    /// whichever Tauri command needed it first.
    pub async fn pool_for(&self, connection_id: &str) -> Option<TransferPool> {
        let slot = self.slot_for(connection_id);
        let guard = slot.lock().await;
        guard.as_ref().map(|session| session.transfer_pool.clone())
    }

    /// Snapshot of every slot currently known — used only for cross-session
    /// sweeps (e.g. app shutdown), never for a single connectionId's
    /// operation (that always goes through `slot_for` + lock).
    pub fn all_slots(&self) -> Vec<SessionSlot> {
        self.inner.lock().unwrap().values().cloned().collect()
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
        }
        can_remove
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn occupied_slots_are_not_removed() {
        let sessions = Sessions::default();
        let slot = sessions.slot_for("connection");
        let guard = slot.lock().await;

        assert!(!sessions.remove_if_empty("connection", &slot));
        drop(guard);
        assert!(sessions.remove_if_empty("connection", &slot));
    }
}

pub async fn teardown_session(slot: &mut Option<Session>) {
    if let Some(mut session) = slot.take() {
        let _ = session.browse_client.disconnect().await;
        session.transfer_pool.destroy().await;
    }
}

/// Shutdown-specific ordering: cancel transfers first, wait for their tasks
/// to settle, then close the browsing connection. The outer coordinator owns
/// the hard timeout, so an uncooperative backend still cannot block exit.
pub async fn teardown_session_for_shutdown(slot: &mut Option<Session>) {
    if let Some(mut session) = slot.take() {
        session.transfer_pool.destroy().await;
        session.transfer_pool.wait_until_idle().await;
        let _ = session.browse_client.disconnect().await;
    }
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
