use crate::local_fs::open_with::OpenWithWatchers;
use crate::local_fs::preview::PreviewPaths;
use crate::runtime::tray;
use crate::runtime::window_bounds::BoundsPersister;
use crate::security::vault::Vault;
use crate::session::{self, ConnectingClients, Sessions};
use crate::store::Store;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

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
}

impl ShutdownCoordinator {
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

/// Transfers still running make a quit a question. With none running, or no
/// word from the renderer at all, it quits straight away, so quitting never
/// depends on the renderer being there to answer.
pub fn quit_route(active_transfers: u32) -> QuitRoute {
    if active_transfers > 0 {
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
    if quit_route(tray::active_transfers(&app)) == QuitRoute::Ask {
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
    if quit_route(tray::active_transfers(app)) == QuitRoute::Ask {
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
    tray::ask_to_quit(app);
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
/// saved, temporary copies removed and the vault locked. Installing an update
/// needs the same tidy state before it hands over to the installer.
pub async fn wind_down(app: AppHandle, window: WebviewWindow) {
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
            for (connection_id, slot) in sessions.all_slots() {
                tasks.spawn(async move {
                    let mut guard = slot.lock().await;
                    session::teardown_session_for_shutdown(&mut guard, &connection_id).await;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_only_while_transfers_run() {
        assert_eq!(quit_route(0), QuitRoute::Now);
        assert_eq!(quit_route(1), QuitRoute::Ask);
        assert_eq!(quit_route(u32::MAX), QuitRoute::Ask);
    }

    #[test]
    fn shutdown_can_only_begin_once() {
        let coordinator = ShutdownCoordinator::default();
        assert!(coordinator.begin());
        assert!(!coordinator.begin());
    }
}
