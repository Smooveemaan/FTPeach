use crate::local_fs::open_with::OpenWithWatchers;
use crate::local_fs::preview::PreviewPaths;
use crate::runtime::tray;
use crate::runtime::window_bounds::BoundsPersister;
use crate::security::vault::Vault;
use crate::session::{self, ConnectingClients, Sessions};
use crate::store::Store;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the window has to show that it is asking about a quit before the
/// backend decides it cannot answer and quits anyway.
const QUIT_PROMPT_TIMEOUT: Duration = Duration::from_secs(10);

/// Makes application shutdown a single, coordinated operation. Window close
/// events can arrive more than once while cleanup is running; only the first
/// one is allowed to start it.
#[derive(Default)]
pub struct ShutdownCoordinator {
    started: AtomicBool,
    pending_flush: Mutex<Option<(String, tokio::sync::oneshot::Sender<bool>)>>,
}

impl ShutdownCoordinator {
    fn request_flush(&self) -> (String, tokio::sync::oneshot::Receiver<bool>) {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        *self.pending_flush.lock().unwrap() = Some((request_id.clone(), sender));
        (request_id, receiver)
    }

    /// Only the current main-window handshake can complete the pending drain.
    pub fn state_flushed(&self, request_id: &str, ok: bool) -> bool {
        let mut pending = self.pending_flush.lock().unwrap();
        if pending.as_ref().is_none_or(|(id, _)| id != request_id) {
            return false;
        }
        if let Some((_, sender)) = pending.take() {
            let _ = sender.send(ok);
        }
        true
    }

    pub fn begin(&self) -> bool {
        self.started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

/// What a request to quit does.
#[derive(Debug, PartialEq, Eq)]
pub enum QuitRoute {
    Now,
    /// Ask the window first: stop the transfers, wait for them, or stay.
    Ask,
}

/// Running transfers and edits that have not been uploaded both need a decision.
pub fn quit_route(active_transfers: u32, unsynced_edits: usize) -> QuitRoute {
    if active_transfers > 0 || unsynced_edits > 0 {
        QuitRoute::Ask
    } else {
        QuitRoute::Now
    }
}

/// What a close request means.
///
/// With `closeToTray` on, closing the window hides it to the tray; otherwise it shuts the
/// application down, asking first while transfers run. Reading that setting and choosing between the two is a
/// decision, not wiring, so it lives with shutdown rather than inside
/// `run()`'s window-event closure.
pub async fn on_close_requested(app: AppHandle, window: WebviewWindow, store: Store) {
    // The close-to-tray preference itself may still be debounced in the UI.
    flush_renderer(&app).await;
    let close_to_tray = store
        .get_settings()
        .await
        .get("closeToTray")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if close_to_tray {
        tray::hide_to_tray(window);
        return;
    }
    if quit_route(
        tray::active_transfers(&app),
        app.state::<OpenWithWatchers>().unsynced_count(),
    ) == QuitRoute::Ask
    {
        ask_window(&app);
        return;
    }
    if app.state::<ShutdownCoordinator>().begin() {
        run(app.clone(), window).await;
    }
}

/// Quitting from outside the window, such as from the tray icon's menu. With
/// transfers running the window comes back to ask.
pub fn quit(app: &AppHandle) {
    if quit_route(
        tray::active_transfers(app),
        app.state::<OpenWithWatchers>().unsynced_count(),
    ) == QuitRoute::Ask
    {
        tray::restore(app);
        ask_window(app);
        return;
    }
    quit_now(app);
}

/// Quits without asking about transfers: nothing is running, or the window
/// already asked.
pub fn quit_now(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            if app.state::<ShutdownCoordinator>().begin() {
                tauri::async_runtime::spawn(run(app.clone(), window));
            }
        }
        None => app.exit(0),
    }
}

fn ask_window(app: &AppHandle) {
    // The question is already on screen.
    if tray::quit_prompt_open(app) {
        return;
    }
    let generation = tray::model_generation(app);
    tray::ask_to_quit(app, app.state::<OpenWithWatchers>().unsynced_count());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUIT_PROMPT_TIMEOUT).await;
        // A window that opens the question sends a model saying so. Hearing
        // nothing at all means it cannot answer, and quitting must not become
        // impossible because of that.
        if tray::model_generation(&app) == generation {
            log::warn!("the window did not answer a quit request in time; quitting");
            quit_now(&app);
        }
    });
}

pub async fn run(app: AppHandle, window: WebviewWindow) {
    wind_down(app.clone(), window).await;
    app.exit(0);
}

/// Everything `run` does short of exiting: connections closed, window bounds
/// saved, temporary copies removed (edited ones kept for recovery) and the
/// vault locked. Installing an update needs the same tidy state before it
/// hands over to the installer.
pub async fn wind_down(app: AppHandle, window: WebviewWindow) -> bool {
    let state_saved = flush_renderer(&app).await;
    let connecting = app.state::<ConnectingClients>().inner().clone();
    let sessions = app.state::<Sessions>().inner().clone();
    let watchers = app.state::<OpenWithWatchers>().inner().clone();
    let paths = app.state::<PreviewPaths>();
    let open_with_dir = paths.open_with_dir.clone();
    let preview_dir = paths.preview_dir.clone();
    let recovery_root = crate::local_fs::edit_recovery::root(&app);
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
            for (connection_id, slot) in sessions.all_slots() {
                tasks.spawn(async move {
                    let mut guard = slot.lock().await;
                    session::teardown_session_for_shutdown(&mut guard, &connection_id).await;
                });
            }
            while tasks.join_next().await.is_some() {}
        };
        // Copies with edits nobody uploaded move to the recovery folder; only
        // the rest is deleted. Cut short by the deadline, the next start
        // collects the session the same way.
        let end_open_with = async {
            if let Some(root) = recovery_root {
                let collected = tokio::task::spawn_blocking(move || {
                    crate::local_fs::edit_recovery::collect(&open_with_dir, &root)
                })
                .await;
                if let Ok(Err(error)) = collected {
                    log::warn!("kept the open-with session for recovery: {error}");
                }
            }
        };
        let remove_session_temp = async {
            let _ = tokio::fs::remove_dir_all(preview_dir).await;
        };
        let lock_vault = vault.lock();

        tokio::join!(
            persist,
            disconnect,
            end_open_with,
            remove_session_temp,
            lock_vault
        );
    };

    // A stuck network operation or locked temp file must never make the app
    // impossible to close. Dropping cleanup after the deadline is deliberate.
    let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, cleanup).await;
    if let Some(emitter) = app.try_state::<crate::runtime::log_emitter::LogEmitter>() {
        emitter.flush().await;
    }
    state_saved
}

async fn flush_renderer(app: &AppHandle) -> bool {
    let coordinator = app.state::<ShutdownCoordinator>();
    let (request_id, receiver) = coordinator.request_flush();
    let emitted = app.emit_to(
        "main",
        "app:flush-state",
        serde_json::json!({"requestId": request_id}),
    );
    let saved = emitted.is_ok() && wait_for_flush(receiver, Duration::from_secs(3)).await;
    if !saved {
        log::warn!("renderer state could not be fully saved before shutdown (failed or timed out)");
    }
    coordinator.state_flushed(&request_id, false);
    saved
}

async fn wait_for_flush(
    receiver: tokio::sync::oneshot::Receiver<bool>,
    deadline: Duration,
) -> bool {
    matches!(tokio::time::timeout(deadline, receiver).await, Ok(Ok(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_for_transfers_or_unsynced_edits() {
        assert_eq!(quit_route(0, 0), QuitRoute::Now);
        assert_eq!(quit_route(1, 0), QuitRoute::Ask);
        assert_eq!(quit_route(u32::MAX, 0), QuitRoute::Ask);
        assert_eq!(quit_route(0, 1), QuitRoute::Ask);
    }

    #[test]
    fn shutdown_can_only_begin_once() {
        let coordinator = ShutdownCoordinator::default();
        assert!(coordinator.begin());
        assert!(!coordinator.begin());
    }

    #[tokio::test]
    async fn only_the_current_flush_request_can_acknowledge_shutdown() {
        let coordinator = ShutdownCoordinator::default();
        let (old, old_reply) = coordinator.request_flush();
        let (current, reply) = coordinator.request_flush();
        assert!(!coordinator.state_flushed(&old, true));
        assert!(old_reply.await.is_err());
        assert!(coordinator.state_flushed(&current, false));
        assert!(!reply.await.unwrap());
        assert!(!coordinator.state_flushed(&current, true));
    }

    #[tokio::test]
    async fn an_unresponsive_renderer_does_not_prevent_shutdown() {
        let (_sender, receiver) = tokio::sync::oneshot::channel();
        assert!(!wait_for_flush(receiver, Duration::from_millis(10)).await);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        sender.send(true).unwrap();
        assert!(wait_for_flush(receiver, Duration::from_millis(10)).await);
    }
}
