//! Shared temp-directory plumbing for the "Open with…" flow (commands/
//! open_with.rs): per-process session directories under the OS temp dir,
//! plus cleanup of sessions abandoned by crashed instances.
use std::sync::Arc;
use tauri::AppHandle;
use tokio::time::Duration;

use crate::protocol::{ProgressInfo, ProgressSink};

const STALE_TEMP_SESSION_AGE: std::time::Duration =
    std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// State shared by open-with commands. Each process gets its own directory,
/// so coordinated shutdown never removes files owned by another running
/// FTPeach instance.
#[derive(Clone)]
pub struct PreviewPaths {
    pub preview_dir: std::path::PathBuf,
    pub open_with_dir: std::path::PathBuf,
}

impl Default for PreviewPaths {
    fn default() -> Self {
        let tmp = std::env::temp_dir();
        let session_id = uuid::Uuid::new_v4().to_string();
        Self {
            preview_dir: tmp.join("ftpeach-preview").join(&session_id),
            open_with_dir: tmp.join("ftpeach-openwith").join(session_id),
        }
    }
}

/// Removes abandoned temp sessions from crashed/force-killed instances.
/// A generous age limit avoids touching another FTPeach instance that is
/// still running, while UUID validation confines deletion to directories
/// created by this application.
pub async fn cleanup_stale_sessions(paths: &PreviewPaths) {
    for current in [&paths.preview_dir, &paths.open_with_dir] {
        let Some(root) = current.parent() else {
            continue;
        };
        let Ok(mut entries) = tokio::fs::read_dir(root).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.as_path() == current.as_path() || !is_managed_session_dir(&path) {
                continue;
            }
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let Ok(metadata) = entry.metadata().await else {
                continue;
            };
            let old_enough = metadata
                .modified()
                .ok()
                .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= STALE_TEMP_SESSION_AGE);
            if old_enough {
                let _ = tokio::fs::remove_dir_all(path).await;
            }
        }
    }
}

fn is_managed_session_dir(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
}

const PREVIEW_PROGRESS_THROTTLE_MS: u64 = 100;

pub fn make_preview_progress_sink(
    app: AppHandle,
    connection_id: String,
    id: String,
) -> ProgressSink {
    use serde::Serialize;
    use tauri::Emitter;

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct PreviewProgressPayload {
        id: String,
        connection_id: String,
        bytes: u64,
        total: u64,
    }

    let last_sent = std::sync::Mutex::new(None::<std::time::Instant>);
    Arc::new(move |info: ProgressInfo| {
        let ProgressInfo::Progress { bytes, total } = info else {
            return;
        };
        let mut guard = last_sent.lock().unwrap();
        let now = std::time::Instant::now();
        if let Some(prev) = *guard
            && now.duration_since(prev) < Duration::from_millis(PREVIEW_PROGRESS_THROTTLE_MS)
        {
            return;
        }
        *guard = Some(now);
        drop(guard);
        let _ = app.emit(
            "preview:progress",
            PreviewProgressPayload {
                id: id.clone(),
                connection_id: connection_id.clone(),
                bytes,
                total,
            },
        );
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_directories_are_isolated_per_process_session() {
        let first = PreviewPaths::default();
        let second = PreviewPaths::default();

        assert_ne!(first.open_with_dir, second.open_with_dir);
        assert_ne!(first.preview_dir, second.preview_dir);
        assert_eq!(
            first.open_with_dir.file_name(),
            first.preview_dir.file_name()
        );
    }

    #[test]
    fn cleanup_scope_accepts_only_uuid_session_directories() {
        assert!(is_managed_session_dir(std::path::Path::new(
            "550e8400-e29b-41d4-a716-446655440000"
        )));
        assert!(!is_managed_session_dir(std::path::Path::new("unrelated")));
        assert!(!is_managed_session_dir(std::path::Path::new("..")));
    }
}
