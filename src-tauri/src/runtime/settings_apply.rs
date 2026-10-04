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
    apply_log_folder(&settings, store, log_emitter);
    if settings
        .get("logToFile")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        log_emitter.set_file_logging_enabled(true);
    }
}

/// Where "Write log to file" writes: the chosen folder, or FTPeach's own
/// logs folder when none is chosen.
pub fn apply_log_folder(settings: &JsonMap, store: &Store, log_emitter: &LogEmitter) {
    let folder = settings
        .get("logFolder")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    log_emitter.set_log_dir(log_folder(folder, store));
}

/// The folder a "Log folder" value stands for: the one typed, or FTPeach's
/// own logs folder when it is empty or not a usable path.
pub fn log_folder(folder: &str, store: &Store) -> std::path::PathBuf {
    chosen_log_folder(folder, crate::local_fs::portable::root()).unwrap_or_else(|| store.logs_dir())
}

/// The folder the user chose, if any. A portable copy keeps one inside it
/// relative, so it moves with the copy; anything else must be absolute.
fn chosen_log_folder(
    folder: &str,
    portable_root: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    Some(folder.trim())
        .filter(|folder| !folder.is_empty())
        .map(|folder| {
            std::path::PathBuf::from(crate::local_fs::portable::resolved_path(
                folder,
                portable_root,
            ))
        })
        .filter(|folder| folder.is_absolute())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_folder_is_the_chosen_one_or_none() {
        assert_eq!(chosen_log_folder("", None), None);
        assert_eq!(chosen_log_folder("  ", None), None);
        assert_eq!(chosen_log_folder("logs", None), None);
        assert_eq!(
            chosen_log_folder(r"D:\logs", None),
            Some(std::path::PathBuf::from(r"D:\logs"))
        );
        let root = std::path::Path::new(r"E:\FTPeach");
        assert_eq!(
            chosen_log_folder("logs", Some(root)),
            Some(root.join("logs"))
        );
    }
}
