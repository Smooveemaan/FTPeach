//! Enforces the vault's auto-lock from the backend.
//!
//! `security::auto_lock` decides; this drives it. A timer in the Tokio
//! runtime asks the policy every few seconds, so the guarantee no longer
//! depends on the renderer's event loop, its timers, or its ability to
//! report anything at all. The renderer only tells the backend when it has
//! seen the user, which can make the vault stay open longer but never
//! keeps it open after the user has gone.

use crate::security::auto_lock::{AutoLock, LockReason, Presence};
use crate::security::sensitive::AuthorizationState;
use crate::security::vault::Vault;
use crate::store::{JsonMap, Store};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Short enough that a locked screen is followed within a second; one session
/// query per tick costs nothing. Hiding the window does not wait for it.
const TICK: Duration = Duration::from_secs(1);

/// The payload every window receives when the vault locks.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultLocked {
    reason: LockReason,
}

/// Applies the saved `vaultAutoLockMinutes`. Called at startup and whenever
/// the setting is saved or replaced by an import, so the running timer and
/// the stored policy never disagree.
pub fn apply_idle_timeout(settings: &JsonMap, auto_lock: &AutoLock) {
    auto_lock.set_idle_minutes(
        settings
            .get(crate::security::security_policy::AUTO_LOCK)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    );
}

pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            enforce(&app).await;
        }
    });
}

/// Applies the policy at once, for a window that was just minimized or hidden.
pub fn enforce_now(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { enforce(&app).await });
}

async fn enforce(app: &tauri::AppHandle) {
    let status = app.state::<Vault>().status().await;
    if !status.configured || status.locked {
        return;
    }
    let presence = Presence {
        session_locked: super::session_lock::session_locked().unwrap_or(false),
        window_hidden: main_window_hidden(app),
    };
    let auto_lock = app.state::<AutoLock>();
    let Some(reason) = crate::security::auto_lock::lock_reason(
        auto_lock.idle_for(),
        auto_lock.idle_timeout(),
        presence,
    ) else {
        return;
    };
    lock_now(app, reason).await;
}

/// Hidden to the tray, or minimized. A window whose state cannot be read is
/// not treated as hidden; the idle timeout still covers that case.
fn main_window_hidden(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
}

/// Locks the vault, withdraws what the unlocked session allowed, and tells
/// every window. The one path for a lock while the windows are alive, so each
/// lock is announced once; shutdown locks the vault directly.
///
/// Connections that are already open keep running: a protocol backend has
/// already authenticated, and dropping a transfer mid-file would lose more
/// than it protects. What the lock does take away is every unused
/// authorization grant, so no secret can be revealed or saved again until
/// the vault is unlocked.
pub async fn lock_now<R: Runtime>(app: &AppHandle<R>, reason: LockReason) {
    app.state::<Vault>().lock().await;
    app.state::<AuthorizationState>().revoke_all();
    announce(app, reason);
}

/// Tells every window the vault is no longer open, so each drops what it was
/// showing and reads the state again. Said by whoever closed it, once: the
/// lock above, and the commands that remove the vault.
pub fn announce<R: Runtime>(app: &AppHandle<R>, reason: LockReason) {
    let _ = app.emit("vault:locked", VaultLocked { reason });
}

/// Brings the timer in line with the settings on disk, at startup.
pub async fn apply_at_startup(store: &Store, auto_lock: &AutoLock) {
    apply_idle_timeout(&store.get_settings().await, auto_lock);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(value: serde_json::Value) -> JsonMap {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_saved_minutes_reach_the_running_timer() {
        let auto_lock = AutoLock::default();
        apply_idle_timeout(
            &settings(serde_json::json!({ "vaultAutoLockMinutes": 15 })),
            &auto_lock,
        );
        assert_eq!(auto_lock.idle_timeout(), Some(Duration::from_secs(900)));
        apply_idle_timeout(
            &settings(serde_json::json!({ "vaultAutoLockMinutes": 0 })),
            &auto_lock,
        );
        assert_eq!(auto_lock.idle_timeout(), None);
    }

    #[test]
    fn a_missing_or_unusable_setting_leaves_no_idle_timer() {
        let auto_lock = AutoLock::default();
        auto_lock.set_idle_minutes(15);
        apply_idle_timeout(
            &settings(serde_json::json!({ "theme": "dark" })),
            &auto_lock,
        );
        assert_eq!(auto_lock.idle_timeout(), None);
        auto_lock.set_idle_minutes(15);
        apply_idle_timeout(
            &settings(serde_json::json!({ "vaultAutoLockMinutes": -1 })),
            &auto_lock,
        );
        assert_eq!(auto_lock.idle_timeout(), None);
    }

    /// What a window hears of each lock, in order.
    fn announcements(
        app: &tauri::App<tauri::test::MockRuntime>,
    ) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
        use tauri::Listener;
        let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = heard.clone();
        app.listen_any("vault:locked", move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });
        heard
    }

    /// A vault that was just set up, so it is open, in a directory of its own.
    async fn open_vault() -> (std::path::PathBuf, Vault) {
        let root = std::env::temp_dir().join(format!("ftpeach-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let vault = Vault::new(root.clone());
        vault.setup("correct horse battery staple").await.unwrap();
        (root, vault)
    }

    const BY_THE_USER: [&str; 1] = [r#"{"reason":"user"}"#];

    /// Removing the vault closes it for the windows as a lock does: one
    /// announcement each, when the removal is over.
    #[tokio::test]
    async fn a_reset_and_a_switch_to_system_protection_are_each_announced_once() {
        let (root, vault) = open_vault().await;
        let store = Store::new_at(root.clone());
        let app = tauri::test::mock_app();
        let heard = announcements(&app);

        crate::commands::vault::authorized_reset(app.handle(), &vault, &Default::default(), &store)
            .await
            .unwrap();
        assert!(!vault.is_configured());
        assert_eq!(*heard.lock().unwrap(), BY_THE_USER);

        vault.setup("correct horse battery staple").await.unwrap();
        crate::commands::vault::authorized_system_protection(app.handle(), &vault, &store)
            .await
            .unwrap();
        assert!(!vault.is_configured());
        assert_eq!(*heard.lock().unwrap(), [BY_THE_USER[0]; 2]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The vault locks before its files are removed, so a reset that cannot
    /// remove them has closed it all the same, and says so.
    #[tokio::test]
    async fn a_reset_that_fails_after_locking_is_still_announced() {
        let (root, vault) = open_vault().await;
        // A directory where the snapshot was cannot be removed as a file.
        std::fs::remove_file(root.join("vault.hold")).unwrap();
        std::fs::create_dir(root.join("vault.hold")).unwrap();
        let app = tauri::test::mock_app();
        let heard = announcements(&app);

        let failed = crate::commands::vault::authorized_reset(
            app.handle(),
            &vault,
            &Default::default(),
            &Store::new_at(root.clone()),
        )
        .await;
        assert!(failed.is_err());
        assert!(!vault.is_unlocked().await);
        assert_eq!(*heard.lock().unwrap(), BY_THE_USER);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// One lock, one announcement, whoever asked; asked again, it says so again.
    #[tokio::test]
    async fn every_lock_is_announced_once_with_its_reason() {
        let (root, vault) = open_vault().await;
        let app = tauri::test::mock_app();
        app.manage(vault.clone());
        app.manage(AuthorizationState::new(vault.clone()));
        let heard = announcements(&app);
        assert!(vault.is_unlocked().await);

        crate::commands::vault::vault_lock(app.handle().clone())
            .await
            .unwrap();
        assert!(!vault.is_unlocked().await);
        assert_eq!(*heard.lock().unwrap(), BY_THE_USER);

        crate::commands::vault::vault_lock(app.handle().clone())
            .await
            .unwrap();
        lock_now(app.handle(), LockReason::Idle).await;
        assert_eq!(
            *heard.lock().unwrap(),
            [
                r#"{"reason":"user"}"#,
                r#"{"reason":"user"}"#,
                r#"{"reason":"idle"}"#
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The lock that follows the user away from the machine is not part of
    /// the setting, so turning the timer off must not turn it off too.
    #[test]
    fn turning_the_idle_timer_off_leaves_the_mandatory_lock_in_place() {
        let auto_lock = AutoLock::default();
        apply_idle_timeout(
            &settings(serde_json::json!({ "vaultAutoLockMinutes": 0 })),
            &auto_lock,
        );
        assert_eq!(
            crate::security::auto_lock::lock_reason(
                Duration::ZERO,
                auto_lock.idle_timeout(),
                Presence {
                    session_locked: true,
                    window_hidden: false,
                },
            ),
            Some(LockReason::SessionLocked)
        );
    }
}
