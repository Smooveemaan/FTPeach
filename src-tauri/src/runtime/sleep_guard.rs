//! Keeps Windows from idling the system to sleep while a transfer is in
//! flight — `transfer_pool.rs`'s `drain()` is the single choke point where a
//! task enters/leaves `PoolState.active` across every `TransferPool`
//! instance (one per connected session), so this counts across all of them
//! rather than per-pool. Same "process-wide singleton" shape as
//! `rate_limiter.rs`'s own `shared()`, guarded by a `Mutex<Inner>` (not bare
//! atomics) so the active-count and enabled-flag transitions that decide
//! whether to call `SetThreadExecutionState` can't race each other. On by
//! default (`enabled: true`) — `preventSleepDuringTransfers`
//! (`settings_apply::apply_prevent_sleep`) is the opt-out, and can flip live
//! mid-transfer, not just at idle.

use std::sync::Mutex;
use std::sync::OnceLock;
#[cfg(windows)]
use windows::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};

struct Inner {
    active: usize,
    enabled: bool,
}

pub struct SleepGuard(Mutex<Inner>);

impl SleepGuard {
    pub fn new() -> Self {
        Self(Mutex::new(Inner {
            active: 0,
            enabled: true,
        }))
    }

    // Only the 0→1 transition (while enabled) actually needs to tell Windows
    // anything — every subsequent concurrent transfer just rides the same guard.
    pub fn transfer_started(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.active += 1;
        if inner.enabled && inner.active == 1 {
            #[cfg(windows)]
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            }
        }
    }

    // Symmetric: only the last transfer finishing (1→0, while enabled)
    // releases the sleep-prevention flag back to normal.
    pub fn transfer_finished(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.active = inner.active.saturating_sub(1);
        if inner.enabled && inner.active == 0 {
            #[cfg(windows)]
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = self.0.lock().unwrap();
        if inner.enabled == enabled {
            return;
        }
        inner.enabled = enabled;
        if inner.active > 0 {
            #[cfg(windows)]
            unsafe {
                if enabled {
                    SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                } else {
                    SetThreadExecutionState(ES_CONTINUOUS);
                }
            }
        }
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.0.lock().unwrap().active
    }

    #[cfg(test)]
    pub fn is_enabled(&self) -> bool {
        self.0.lock().unwrap().enabled
    }
}

static SHARED: OnceLock<SleepGuard> = OnceLock::new();

pub fn shared() -> &'static SleepGuard {
    SHARED.get_or_init(SleepGuard::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_is_a_process_wide_singleton() {
        assert!(std::ptr::eq(shared(), shared()));
    }

    #[test]
    fn counter_tracks_concurrent_transfers_and_returns_to_zero() {
        let guard = SleepGuard::new();
        guard.transfer_started();
        guard.transfer_started();
        assert_eq!(guard.active_count(), 2);
        guard.transfer_finished();
        assert_eq!(guard.active_count(), 1);
        guard.transfer_finished();
        assert_eq!(guard.active_count(), 0);
    }

    #[test]
    fn disabling_and_re_enabling_does_not_touch_the_active_count() {
        let guard = SleepGuard::new();
        guard.transfer_started();
        guard.set_enabled(false);
        assert!(!guard.is_enabled());
        assert_eq!(guard.active_count(), 1);
        guard.set_enabled(true);
        assert!(guard.is_enabled());
        assert_eq!(guard.active_count(), 1);
        guard.transfer_finished();
        assert_eq!(guard.active_count(), 0);
    }

    #[test]
    fn setting_the_same_enabled_value_twice_is_a_no_op() {
        let guard = SleepGuard::new();
        assert!(guard.is_enabled());
        guard.set_enabled(true);
        assert!(guard.is_enabled());
    }
}
