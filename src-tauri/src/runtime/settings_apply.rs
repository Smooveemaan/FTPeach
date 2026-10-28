//! Pushing the saved settings into the running process: the shared rate
//! limiter, the sleep guard, and the log's date format, folder and file.
//!
//! [`apply`] is the one rule for all three places that need it: startup, a
//! save and a settings import.

use crate::runtime::log_emitter::LogEmitter;
use crate::store::{JsonMap, Store};

/// Brings the process in line with `settings`. Every setter is cheap and
/// idempotent, so all of them run whatever changed.
pub fn apply(settings: &JsonMap, store: &Store, log_emitter: &LogEmitter) {
    apply_transfer_limits(settings);
    apply_prevent_sleep(settings);
    apply_log_date_format(settings, log_emitter);
    apply_log_folder(settings, store, log_emitter);
    log_emitter.set_file_logging_enabled(
        settings
            .get("logToFile")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    );
}

/// Where "Write log to file" writes: the chosen folder, or FTPeach's own
/// logs folder when none is chosen.
fn apply_log_folder(settings: &JsonMap, store: &Store, log_emitter: &LogEmitter) {
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

fn apply_log_date_format(settings: &JsonMap, log_emitter: &LogEmitter) {
    let format = settings
        .get("dateFormat")
        .and_then(|value| value.as_str())
        .unwrap_or("locale");
    log_emitter.set_date_format(format);
}

fn apply_transfer_limits(settings: &JsonMap) {
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

fn apply_prevent_sleep(settings: &JsonMap) {
    let enabled = settings
        .get("preventSleepDuringTransfers")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    crate::runtime::sleep_guard::shared().set_enabled(enabled);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Absolute folders on this system.
    const LOGS: &str = if cfg!(windows) {
        r"D:\logs"
    } else {
        "/var/log/ftpeach"
    };
    const PORTABLE: &str = if cfg!(windows) {
        r"E:\FTPeach"
    } else {
        "/media/usb/FTPeach"
    };

    /// What a save or an import turns off is turned off too, not only what
    /// it turns on.
    #[tokio::test]
    async fn every_log_setting_follows_the_settings_both_ways() {
        let root = std::env::temp_dir().join(format!("ftpeach-apply-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(root.clone());
        let emitter = LogEmitter::start(root.join("logs"), |_| {});
        let settings = |value| serde_json::from_value::<JsonMap>(value).unwrap();
        apply(
            &settings(serde_json::json!({
                "logToFile": true, "dateFormat": "iso", "logFolder": LOGS
            })),
            &store,
            &emitter,
        );
        assert_eq!(
            emitter.settings_in_use(),
            (true, "iso".into(), std::path::PathBuf::from(LOGS))
        );
        apply(
            &settings(serde_json::json!({"logToFile": false})),
            &store,
            &emitter,
        );
        assert_eq!(
            emitter.settings_in_use(),
            (false, "locale".into(), store.logs_dir())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_log_folder_is_the_chosen_one_or_none() {
        assert_eq!(chosen_log_folder("", None), None);
        assert_eq!(chosen_log_folder("  ", None), None);
        assert_eq!(chosen_log_folder("logs", None), None);
        assert_eq!(
            chosen_log_folder(LOGS, None),
            Some(std::path::PathBuf::from(LOGS))
        );
        let root = std::path::Path::new(PORTABLE);
        assert_eq!(
            chosen_log_folder("logs", Some(root)),
            Some(root.join("logs"))
        );
    }
}
