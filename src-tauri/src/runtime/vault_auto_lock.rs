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
use tauri::{Emitter, Manager};

/// Short enough that a locked screen is followed quickly, long enough that
/// the idle timeout, which is set in whole minutes, costs nothing to track.
const TICK: Duration = Duration::from_secs(5);

/// The payload every window receives when the vault locks itself.
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

/// Locks the vault and withdraws what the unlocked session allowed.
///
/// Connections that are already open keep running: a protocol backend has
/// already authenticated, and dropping a transfer mid-file would lose more
/// than it protects. What the lock does take away is every unused
/// authorization grant, so no secret can be revealed or saved again until
/// the vault is unlocked.
pub async fn lock_now(app: &tauri::AppHandle, reason: LockReason) {
    app.state::<Vault>().lock().await;
    app.state::<AuthorizationState>().revoke_all();
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
