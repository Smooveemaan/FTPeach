//! Pushing a saved setting into the running process: the shared rate
//! limiter, the sleep guard, and the log emitter's date format.
//!
//! These are applied from three places -- at startup, when settings are
//! saved, and when a settings import replaces them -- so they belong to the
//! runtime rather than to whichever command module ran them first.

use crate::runtime::log_emitter::LogEmitter;
use crate::store::{JsonMap, Store};

/// Brings the process in line with the saved settings once, at startup.
///
/// The same three settings are applied when the user saves them and when an
/// import replaces them; doing it here as well keeps the startup path from
/// spelling the rules out a fourth time inside `run()`.
pub async fn apply_at_startup(store: &Store, log_emitter: &LogEmitter) {
    let settings = store.get_settings().await;
    apply_transfer_limits(&settings);
    apply_prevent_sleep(&settings);
    apply_log_date_format(&settings, log_emitter);
    if settings
        .get("logToFile")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        log_emitter.set_file_logging_enabled(true);
    }
}

pub fn apply_log_date_format(settings: &JsonMap, log_emitter: &LogEmitter) {
    let format = settings
        .get("dateFormat")
        .and_then(|value| value.as_str())
        .unwrap_or("locale");
    log_emitter.set_date_format(format);
}

pub fn apply_transfer_limits(settings: &JsonMap) {
    let concurrency = settings
        .get("concurrency")
        .and_then(|v| v.as_u64())
        .unwrap_or(3);
    crate::transfer::concurrency_limiter::shared().set_limit(concurrency as usize);
    let kbps = settings
        .get("transferSpeedLimitKBps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    crate::transfer::rate_limiter::shared().set_rate(kbps * 1024);
}

pub fn apply_prevent_sleep(settings: &JsonMap) {
    let enabled = settings
        .get("preventSleepDuringTransfers")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    crate::runtime::sleep_guard::shared().set_enabled(enabled);
}
