//! Local directory listing — the one FTPeach filesystem operation with no
//! destructive-safety invariants to enforce, just untrusted-name filtering
//! (see is_safe_path_segment) and per-platform hidden-file detection.

use serde::Serialize;
use std::path::Path;
use std::time::SystemTime;
use tokio_util::sync::CancellationToken;

const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
static LIST_SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
type Requests = std::collections::HashMap<String, (u64, CancellationToken)>;
static REQUESTS: std::sync::LazyLock<std::sync::Mutex<Requests>> =
    std::sync::LazyLock::new(Default::default);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) struct ListingRequest {
    key: Option<String>,
    generation: u64,
    pub token: CancellationToken,
}

impl ListingRequest {
    pub(crate) fn cancel(key: &str) {
        if let Some((_, token)) = REQUESTS.lock().unwrap().get(key) {
            token.cancel();
        }
    }
    pub(crate) fn start(key: Option<String>) -> std::io::Result<Self> {
        let token = CancellationToken::new();
        let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(key) = &key {
            let mut requests = REQUESTS.lock().unwrap();
            if key.len() > 256 || (requests.len() >= 128 && !requests.contains_key(key)) {
                return Err(std::io::Error::other(
                    "Local listing request budget exceeded",
                ));
            }
            if let Some((_, previous)) = requests.insert(key.clone(), (generation, token.clone())) {
                previous.cancel();
            }
        }
        Ok(Self {
            key,
            generation,
            token,
        })
    }
}

impl Drop for ListingRequest {
    fn drop(&mut self) {
        self.token.cancel();
        if let Some(key) = &self.key {
            let mut requests = REQUESTS.lock().unwrap();
            if requests
                .get(key)
                .is_some_and(|(generation, _)| *generation == self.generation)
            {
                requests.remove(key);
            }
        }
    }
}

fn is_safe_path_segment(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['\\', '/'])
}

fn iso(t: std::io::Result<SystemTime>) -> Option<String> {
    let t = t.ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsEntry {
    pub(crate) name: String,
    pub(crate) is_directory: bool,
    pub(crate) is_hidden: bool,
    pub(crate) size: u64,
    pub(crate) modified_at: Option<String>,
    pub(crate) created_at: Option<String>,
}

pub(crate) async fn list_directory(
    target: &Path,
    token: &CancellationToken,
) -> std::io::Result<Vec<FsEntry>> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "Local listing cancelled")),
        result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let permit = LIST_SLOTS.clone().acquire_owned().await.map_err(std::io::Error::other)?;
            let target = target.to_owned();
            let token = token.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                list_bounded(&target, MAX_ENTRIES, MAX_BYTES, &token)
            }).await.map_err(std::io::Error::other)?
        }) => result.unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Local listing deadline exceeded"))),
    }
}

fn list_bounded(
    target: &Path,
    max_entries: usize,
    max_bytes: usize,
    token: &CancellationToken,
) -> std::io::Result<Vec<FsEntry>> {
    list_with_metadata(
        target,
        max_entries,
        max_bytes,
        token,
        std::fs::DirEntry::metadata,
    )
}

fn list_with_metadata(
    target: &Path,
    max_entries: usize,
    max_bytes: usize,
    token: &CancellationToken,
    mut metadata: impl FnMut(&std::fs::DirEntry) -> std::io::Result<std::fs::Metadata>,
) -> std::io::Result<Vec<FsEntry>> {
    if token.is_cancelled() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "Local listing cancelled",
        ));
    }
    let read_dir = std::fs::read_dir(target)?;
    let mut entries = Vec::new();
    let mut bytes = 0usize;
    for next in read_dir {
        if token.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Local listing cancelled",
            ));
        }
        let next = next?;
        let name = next.file_name().to_string_lossy().into_owned();
        if !is_safe_path_segment(&name) {
            continue;
        }
        bytes = bytes.saturating_add(name.len() + std::mem::size_of::<FsEntry>() + 128);
        if entries.len() >= max_entries || bytes > max_bytes {
            return Err(std::io::Error::other(
                "Local directory exceeds listing entry/memory budget",
            ));
        }
        // Never turn an inaccessible directory into a zero-byte ordinary file.
        let meta = metadata(&next).map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("Metadata unavailable for {name}: {error}"),
            )
        })?;
        let is_directory = meta.is_dir();
        let size = meta.len();
        let modified_at = iso(meta.modified());
        let created_at = iso(meta.created());
        #[cfg(windows)]
        let is_hidden = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & 0x2 != 0 || name.starts_with('.')
        };
        #[cfg(not(windows))]
        let is_hidden = name.starts_with('.');
        entries.push(FsEntry {
            name,
            is_directory,
            is_hidden,
            size,
            modified_at,
            created_at,
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_failure_and_mid_listing_cancellation_never_publish_partial_rows() {
        let root = std::env::temp_dir().join(format!("ftpeach-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("directory")).unwrap();
        std::fs::write(root.join("file"), b"fixture").unwrap();
        let token = CancellationToken::new();
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::NotFound,
        ] {
            let result = list_with_metadata(&root, MAX_ENTRIES, MAX_BYTES, &token, |_| {
                Err(std::io::Error::new(kind, "injected metadata failure"))
            });
            let error = result.err().unwrap();
            assert_eq!(error.kind(), kind);
            assert!(error.to_string().contains("Metadata unavailable"));
        }
        let mut calls = 0;
        let result = list_with_metadata(&root, MAX_ENTRIES, MAX_BYTES, &token, |entry| {
            calls += 1;
            token.cancel();
            entry.metadata()
        });
        assert_eq!(
            result.err().unwrap().kind(),
            std::io::ErrorKind::Interrupted
        );
        assert_eq!(calls, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_precedes_filesystem_access() {
        let token = CancellationToken::new();
        token.cancel();
        assert_eq!(
            list_directory(Path::new("nonexistent"), &token)
                .await
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::Interrupted
        );
    }

    #[test]
    fn superseding_request_cancels_only_its_own_slot() {
        let key = uuid::Uuid::new_v4().to_string();
        let first = ListingRequest::start(Some(key.clone())).unwrap();
        let other = ListingRequest::start(Some(uuid::Uuid::new_v4().to_string())).unwrap();
        let second = ListingRequest::start(Some(key.clone())).unwrap();
        assert!(first.token.is_cancelled());
        assert!(!other.token.is_cancelled());
        drop(first);
        let third = ListingRequest::start(Some(key)).unwrap();
        assert!(second.token.is_cancelled());
        assert!(!third.token.is_cancelled());
    }

    #[tokio::test]
    async fn listing_rejects_entry_and_byte_budget_overflow() {
        let root = std::env::temp_dir().join(format!("ftpeach-list-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("file"), b"data").unwrap();
        let token = CancellationToken::new();
        assert!(list_bounded(&root, 0, MAX_BYTES, &token).is_err());
        assert!(list_bounded(&root, MAX_ENTRIES, 1, &token).is_err());
        let entries = list_bounded(&root, 1, MAX_BYTES, &token).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size, 4);
        std::fs::remove_dir_all(root).unwrap();
    }
}
