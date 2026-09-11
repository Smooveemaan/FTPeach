//! The application log: `log::` records from the backend, and warnings and
//! errors from the interface, written to `ftpeach-app.log` in the logs folder.
//!
//! It runs in release builds too. Update checks, staging-file cleanup, storage
//! and journal failures only ever report through `log::warn!`, and without a
//! file behind it a user's problem left no trace at all. The diagnostic bundle
//! carries the end of this file.

use crate::runtime::diagnostics::redact;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
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
