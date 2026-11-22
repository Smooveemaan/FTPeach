//! The application log: `log::` records from the backend, and warnings and
//! errors from the interface, written to `ftpeach-app.log` in the logs folder.
//!
//! It runs in release builds too. Update checks, staging-file cleanup, storage
//! and journal failures only ever report through `log::warn!`, and without a
//! file behind it a user's problem left no trace at all. The diagnostic bundle
//! carries the end of this file.

use crate::security::redaction::redact;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;
use tauri::Runtime;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Starts with a letter after `ftpeach-`, so the protocol log's cleanup,
/// which only touches dated `ftpeach-<date>.log` files, leaves it alone.
const FILE_NAME: &str = "ftpeach-app";
/// The plugin renames a full file with a date suffix and keeps this many,
/// the active one included: at most about 3 MiB on disk.
const MAX_FILE_BYTES: u128 = 1024 * 1024;
const KEPT_FILES: usize = 3;
/// How much of the end of the log goes into a diagnostic bundle.
const TAIL_BYTES: u64 = 256 * 1024;
static EXTENDED_LOGGING: AtomicBool = AtomicBool::new(false);

fn accepts(metadata: &log::Metadata<'_>, extended: bool) -> bool {
    metadata.level() <= log::Level::Info
        || (extended
            && metadata.level() == log::Level::Debug
            && metadata.target().starts_with("app_lib::runtime::"))
}

/// Applies diagnostic logging immediately, including changes from settings imports.
pub fn apply_settings(settings: &crate::store::JsonMap) {
    let enabled = settings
        .get("extendedLogging")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if EXTENDED_LOGGING.swap(enabled, Ordering::Relaxed) != enabled {
        log::info!(
            "extended diagnostic logging enabled={enabled}; version={}; os={}; arch={}; pid={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::process::id()
        );
    }
}

/// Loads the saved diagnostic mode and checks the native event loop without queuing repeated probes.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        apply_settings(&app.state::<crate::store::Store>().get_settings().await);
        log::debug!("startup: application logger ready");
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if !EXTENDED_LOGGING.load(Ordering::Relaxed) {
                continue;
            }
            let (reply, mut response) = tokio::sync::oneshot::channel();
            if let Err(error) = app.run_on_main_thread(move || {
                let _ = reply.send(());
            }) {
                log::debug!("main-thread probe could not be queued: {error}");
                return;
            }
            match tokio::time::timeout(Duration::from_secs(2), &mut response).await {
                Ok(Ok(())) => log::debug!("main-thread probe answered"),
                Ok(Err(_)) => return,
                Err(_) => {
                    log::debug!("main thread has not answered for 2 seconds");
                    // Keep just this probe queued until the event loop responds.
                    if response.await.is_err() {
                        return;
                    }
                    log::debug!("main thread responds again");
                }
            }
        }
    });
}

pub fn plugin<R: Runtime>(logs_dir: PathBuf) -> TauriPlugin<R> {
    let mut targets = vec![Target::new(TargetKind::Folder {
        path: logs_dir,
        file_name: Some(FILE_NAME.into()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    tauri_plugin_log::Builder::new()
        .targets(targets)
        // Dependencies only when something is wrong; the app's own records
        // from Info up. Interface records arrive as warnings and errors.
        .level(log::LevelFilter::Warn)
        .level_for("app_lib", log::LevelFilter::Info)
        .level_for("app_lib::runtime", log::LevelFilter::Debug)
        .filter(|metadata| accepts(metadata, EXTENDED_LOGGING.load(Ordering::Relaxed)))
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(KEPT_FILES))
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} {:<5} {}: {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                redact(&message.to_string())
            ));
        })
        .build()
}

/// Sends a panic's message to the log before the default hook runs. Release
/// builds abort on panic, so this is the only record one leaves behind.
pub fn record_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("{info}");
        previous(info);
    }));
}

/// The last lines of the application log, oldest first. Reaches into the
/// newest rotated file when the active one was only just started.
pub async fn tail(logs_dir: &Path) -> Vec<String> {
    let current = logs_dir.join(format!("{FILE_NAME}.log"));
    let mut text = read_tail(&current, TAIL_BYTES).await.unwrap_or_default();
    let remaining = TAIL_BYTES.saturating_sub(text.len() as u64);
    if remaining > 0
        && let Some(archived) = newest_archive(logs_dir).await
    {
        let older = read_tail(&archived, remaining).await.unwrap_or_default();
        text = older + &text;
    }
    redact(&text)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

async fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let start = file.metadata().await?.len().saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).await?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // Starting mid-file cuts the first line; drop it rather than show half.
    Ok(if start > 0 {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_owned())
            .unwrap_or_default()
    } else {
        text
    })
}

/// Rotated files are named `ftpeach-app_<date>.log` with a sortable date.
async fn newest_archive(logs_dir: &Path) -> Option<PathBuf> {
    let prefix = format!("{FILE_NAME}_");
    let mut entries = tokio::fs::read_dir(logs_dir).await.ok()?;
    let mut newest: Option<String> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix)
            && name.ends_with(".log")
            && newest.as_ref().is_none_or(|current| name > *current)
        {
            newest = Some(name);
        }
    }
    newest.map(|name| logs_dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_logging_keeps_runtime_diagnostics_opt_in_and_excludes_dependency_debug_logs() {
        for (target, level, enabled, expected) in [
            (
                "app_lib::runtime::shutdown",
                log::Level::Debug,
                false,
                false,
            ),
            ("app_lib::runtime::shutdown", log::Level::Debug, true, true),
            ("app_lib::runtime::shutdown", log::Level::Trace, true, false),
            ("ssh2", log::Level::Debug, true, false),
            ("app_lib::protocol", log::Level::Debug, true, false),
            ("app_lib::runtime::tray", log::Level::Warn, false, true),
        ] {
            let metadata = log::Metadata::builder().target(target).level(level).build();
            assert_eq!(
                accepts(&metadata, enabled),
                expected,
                "{target} {level} enabled={enabled}"
            );
        }
    }

    #[tokio::test]
    async fn tail_reads_the_newest_lines_across_a_rotation_and_redacts_them() {
        let dir = std::env::temp_dir().join(format!("ftpeach-app-log-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join("ftpeach-app_2026-09-10_08-00-00.log"),
            "older archive\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            dir.join("ftpeach-app_2026-09-11_08-00-00.log"),
            "archived line\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            dir.join("ftpeach-app.log"),
            "first line\npassword=hunter2\n",
        )
        .await
        .unwrap();

        assert_eq!(
            tail(&dir).await,
            vec!["archived line", "first line", "password=[REDACTED]"]
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn a_tail_cut_mid_file_starts_at_a_whole_line() {
        let dir = std::env::temp_dir().join(format!("ftpeach-app-log-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("log.log");
        tokio::fs::write(&path, "0123456789\nabc\n").await.unwrap();
        assert_eq!(read_tail(&path, 8).await.unwrap(), "abc\n");
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
