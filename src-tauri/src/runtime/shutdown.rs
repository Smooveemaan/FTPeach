use crate::local_fs::open_with::OpenWithWatchers;
use crate::local_fs::preview::PreviewPaths;
use crate::runtime::window_bounds::BoundsPersister;
use crate::security::vault::Vault;
use crate::session::{self, ConnectingClients, Sessions};
use crate::store::Store;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Makes application shutdown a single, coordinated operation. Window close
/// events can arrive more than once while cleanup is running; only the first
/// one is allowed to start it.
#[derive(Default)]
pub struct ShutdownCoordinator {
    started: AtomicBool,
}

impl ShutdownCoordinator {
    pub fn begin(&self) -> bool {
        self.started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

/// What a close request means.
///
/// With `closeToTray` on, closing the window hides it; otherwise it shuts the
/// application down. Reading that setting and choosing between the two is a
/// decision, not wiring, so it lives with shutdown rather than inside
/// `run()`'s window-event closure.
pub async fn on_close_requested(app: AppHandle, window: WebviewWindow, store: Store) {
    let close_to_tray = store
        .get_settings()
        .await
        .get("closeToTray")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if close_to_tray {
        let _ = window.hide();
        return;
    }
    if app.state::<ShutdownCoordinator>().begin() {
        run(app.clone(), window).await;
    }
}

pub async fn run(app: AppHandle, window: WebviewWindow) {
    let connecting = app.state::<ConnectingClients>().inner().clone();
    let sessions = app.state::<Sessions>().inner().clone();
    let watchers = app.state::<OpenWithWatchers>().inner().clone();
    let paths = app.state::<PreviewPaths>();
    let open_with_dir = paths.open_with_dir.clone();
    let preview_dir = paths.preview_dir.clone();
    let store = app.state::<Store>().inner().clone();
    let vault = app.state::<Vault>().inner().clone();

    // These are synchronous signals, so issue them before spending any of the
    // timeout waiting for locks or network disconnects.
    connecting.cancel_all();
    watchers.stop_all();

    let cleanup = async move {
        let persister = BoundsPersister::new(store);
        let persist = persister.persist_now(&window);
        let disconnect = async {
            let mut tasks = tokio::task::JoinSet::new();
            for slot in sessions.all_slots() {
                tasks.spawn(async move {
                    let mut guard = slot.lock().await;
                    session::teardown_session_for_shutdown(&mut guard).await;
                });
            }
            while tasks.join_next().await.is_some() {}
        };
        let remove_session_temp = async {
            let _ = tokio::fs::remove_dir_all(open_with_dir).await;
            let _ = tokio::fs::remove_dir_all(preview_dir).await;
        };
        let lock_vault = vault.lock();

        tokio::join!(persist, disconnect, remove_session_temp, lock_vault);
    };

    // A stuck network operation or locked temp file must never make the app
    // impossible to close. Dropping cleanup after the deadline is deliberate.
    let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, cleanup).await;
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_can_only_begin_once() {
        let coordinator = ShutdownCoordinator::default();
        assert!(coordinator.begin());
        assert!(!coordinator.begin());
    }
}
