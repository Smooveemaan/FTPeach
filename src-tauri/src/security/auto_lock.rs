//! When an unlocked vault has to lock itself again.
//!
//! The rule used to live in the renderer, which meant the protection was
//! only as alive as the WebView's event loop and its timers: a hung or
//! reloaded renderer left the vault open, and turning the idle timeout off
//! also turned off the lock that is supposed to happen when the user walks
//! away from the machine. The decision is made here, from state the backend
//! owns, and `runtime::vault_auto_lock` acts on it.
//!
//! This module only decides. Reading the Windows session state and locking
//! the vault are the runtime's job, so the policy stays testable without a
//! window, a desktop session or a clock.
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Why the vault locked, as reported to every open window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    /// Nobody touched the application for the configured idle timeout.
    Idle,
    /// Windows reported the desktop session as locked.
    SessionLocked,
    /// The main window was hidden to the tray or minimized.
    WindowHidden,
    /// The user locked it, from the tray or the settings dialog. Never a
    /// result of [`lock_reason`].
    User,
}

/// What the backend can see about the user at one moment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Presence {
    /// The Windows session is locked. Unknown counts as not locked: the
    /// idle timeout still applies, and a probe that cannot answer must not
    /// lock the vault out from under a user who is sitting right there.
    pub session_locked: bool,
    /// The main window is hidden to the tray or minimized.
    pub window_hidden: bool,
}

/// Why the vault should lock now, if it should.
///
/// Leaving the machine locks the vault whatever the idle timeout says. That
/// separation is the point: `vaultAutoLockMinutes = 0` disables the idle
/// timer alone, never the lock that follows the user away from the screen.
pub fn lock_reason(
    idle_for: Duration,
    idle_timeout: Option<Duration>,
    presence: Presence,
) -> Option<LockReason> {
    if presence.session_locked {
        return Some(LockReason::SessionLocked);
    }
    if presence.window_hidden {
        return Some(LockReason::WindowHidden);
    }
    match idle_timeout {
        Some(timeout) if idle_for >= timeout => Some(LockReason::Idle),
        _ => None,
    }
}

/// The idle timeout and the last time the user was seen, owned by the
/// backend so that a renderer which stops reporting only ever shortens the
/// time to a lock.
pub struct AutoLock {
    idle_minutes: AtomicU64,
    last_activity: Mutex<Instant>,
}

impl Default for AutoLock {
    fn default() -> Self {
        Self {
            idle_minutes: AtomicU64::new(0),
            last_activity: Mutex::new(Instant::now()),
        }
    }
}

impl AutoLock {
    /// Applies the saved `vaultAutoLockMinutes`; `0` means no idle timeout.
    pub fn set_idle_minutes(&self, minutes: u64) {
        self.idle_minutes.store(minutes, Ordering::Relaxed);
    }

    pub fn idle_timeout(&self) -> Option<Duration> {
        match self.idle_minutes.load(Ordering::Relaxed) {
            0 => None,
            minutes => Some(Duration::from_secs(minutes.saturating_mul(60))),
        }
    }

    /// Records that the user was seen. The renderer reports this, and so do
    /// backend events that only a present user can cause.
    pub fn note_activity(&self) {
        self.note_activity_at(Instant::now());
    }

    pub fn note_activity_at(&self, at: Instant) {
        if let Ok(mut last) = self.last_activity.lock() {
            *last = at;
        }
    }

    pub fn idle_for(&self) -> Duration {
        self.idle_since(Instant::now())
    }

    pub fn idle_since(&self, now: Instant) -> Duration {
        self.last_activity
            .lock()
            .map_or(Duration::ZERO, |last| now.saturating_duration_since(*last))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEN_MINUTES: Duration = Duration::from_secs(600);

    #[test]
    fn an_idle_timeout_of_zero_still_locks_when_the_user_leaves() {
        let away = Presence {
            session_locked: true,
            window_hidden: false,
        };
        assert_eq!(
            lock_reason(Duration::ZERO, None, away),
            Some(LockReason::SessionLocked)
        );
        let hidden = Presence {
            session_locked: false,
            window_hidden: true,
        };
        assert_eq!(
            lock_reason(Duration::ZERO, None, hidden),
            Some(LockReason::WindowHidden)
        );
    }

    #[test]
    fn a_present_user_keeps_the_vault_open_until_the_timeout() {
        let present = Presence::default();
        assert_eq!(
            lock_reason(Duration::ZERO, Some(TEN_MINUTES), present),
            None
        );
        assert_eq!(
            lock_reason(
                TEN_MINUTES - Duration::from_secs(1),
                Some(TEN_MINUTES),
                present
            ),
            None
        );
        assert_eq!(
            lock_reason(TEN_MINUTES, Some(TEN_MINUTES), present),
            Some(LockReason::Idle)
        );
        assert_eq!(
            lock_reason(Duration::from_secs(86_400), None, present),
            None
        );
    }

    #[test]
    fn leaving_the_machine_is_reported_ahead_of_the_idle_timer() {
        let away = Presence {
            session_locked: true,
            window_hidden: true,
        };
        assert_eq!(
            lock_reason(Duration::from_secs(86_400), Some(TEN_MINUTES), away),
            Some(LockReason::SessionLocked)
        );
    }

    #[test]
    fn the_idle_timeout_follows_the_saved_setting() {
        let state = AutoLock::default();
        assert_eq!(state.idle_timeout(), None);
        state.set_idle_minutes(15);
        assert_eq!(state.idle_timeout(), Some(Duration::from_secs(900)));
        state.set_idle_minutes(0);
        assert_eq!(state.idle_timeout(), None);
    }

    #[test]
    fn reported_activity_restarts_the_idle_period() {
        let state = AutoLock::default();
        let start = Instant::now();
        state.note_activity_at(start);
        assert_eq!(state.idle_since(start + TEN_MINUTES), TEN_MINUTES);
        state.note_activity_at(start + TEN_MINUTES);
        assert_eq!(state.idle_since(start + TEN_MINUTES), Duration::ZERO);
    }
}
