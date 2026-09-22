//! Copies opened in an external editor with "Open with…". Each copy records
//! the signature (modification time and length) the server is known to hold:
//! the file as downloaded, then each revision the user uploaded. A copy that
//! no longer matches it carries edits nobody has uploaded, and those are never
//! deleted here; see [`super::edit_recovery`].
//!
//! The registry is mirrored to `copies.json` in the session directory, so a
//! crash leaves enough behind for the next start to tell edited copies from
//! untouched ones. It holds paths and signatures only, never credentials.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(1);
pub(crate) const MANIFEST: &str = "copies.json";

/// What identifies one revision of a copy on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Signature {
    secs: u64,
    nanos: u32,
    len: u64,
}

impl Signature {
    pub(crate) fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Self::from_metadata(&meta))
    }

    pub(crate) fn from_metadata(meta: &std::fs::Metadata) -> Self {
        let modified = meta
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        Self {
            secs: modified.as_secs(),
            nanos: modified.subsec_nanos(),
            len: meta.len(),
        }
    }

    /// The token the renderer hands back once this revision is uploaded.
    pub(crate) fn revision(&self) -> String {
        format!("{}.{:09}-{}", self.secs, self.nanos, self.len)
    }

    fn parse(revision: &str) -> Option<Self> {
        let (time, len) = revision.split_once('-')?;
        let (secs, nanos) = time.split_once('.')?;
        Some(Self {
            secs: secs.parse().ok()?,
            nanos: nanos.parse().ok()?,
            len: len.parse().ok()?,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyRecord {
    pub(crate) local_path: PathBuf,
    pub(crate) remote_path: String,
    /// `None` when the copy could not be read right after download; such a
    /// copy counts as edited whenever it exists.
    pub(crate) synced: Option<Signature>,
}

impl CopyRecord {
    /// The copy exists and differs from what the server was last given.
    pub(crate) fn has_unsynced_edits(&self) -> bool {
        match Signature::of(&self.local_path) {
            Some(current) => self.synced != Some(current),
            // A sharing/access error is not proof that an edit is clean.
            None => {
                !matches!(std::fs::metadata(&self.local_path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            }
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub(crate) copies: BTreeMap<String, CopyRecord>,
}

impl Manifest {
    pub(crate) fn read(dir: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(dir.join(MANIFEST)).ok()?).ok()
    }

    pub(crate) fn write(&self, dir: &Path) -> std::io::Result<()> {
        let staging = dir.join(format!("{MANIFEST}.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&staging, serde_json::to_vec(self)?)?;
        std::fs::rename(&staging, dir.join(MANIFEST)).inspect_err(|_| {
            let _ = std::fs::remove_file(&staging);
        })
    }
}

struct State {
    dir: PathBuf,
    manifest: Manifest,
    polls: HashMap<String, Arc<AtomicBool>>,
}

#[derive(Clone)]
pub struct OpenWithWatchers {
    inner: Arc<Mutex<State>>,
}

impl OpenWithWatchers {
    /// Read the files, rather than the last poll, so a save just before exit counts.
    pub fn unsynced_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap()
            .manifest
            .copies
            .values()
            .filter(|copy| copy.has_unsynced_edits())
            .count()
    }

    /// `dir` is this process's open-with session directory.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(State {
                dir,
                manifest: Manifest::default(),
                polls: HashMap::new(),
            })),
        }
    }

    fn persist(state: &State) {
        if let Err(error) = state.manifest.write(&state.dir) {
            log::warn!("could not record the open-with copies: {error}");
        }
    }

    /// Records a downloaded copy before any editor can change it, so even the
    /// first save after opening differs from the recorded signature.
    pub fn register(&self, id: &str, local_path: PathBuf, remote_path: String) {
        let synced = Signature::of(&local_path);
        let mut state = self.inner.lock().unwrap();
        state.manifest.copies.insert(
            id.to_string(),
            CopyRecord {
                local_path,
                remote_path,
                synced,
            },
        );
        Self::persist(&state);
    }

    /// Drops a copy that never reached an editor.
    pub fn forget(&self, id: &str) {
        let mut state = self.inner.lock().unwrap();
        if state.manifest.copies.remove(id).is_some() {
            Self::persist(&state);
        }
    }

    /// Starts reporting changes to a registered copy, measured from its
    /// recorded signature.
    pub fn start(&self, app: AppHandle, id: String) {
        let stop = Arc::new(AtomicBool::new(false));
        let (local_path, mut last) = {
            let mut state = self.inner.lock().unwrap();
            let Some(record) = state.manifest.copies.get(&id) else {
                return;
            };
            let watched = (record.local_path.clone(), record.synced);
            if let Some(previous) = state.polls.insert(id.clone(), stop.clone()) {
                previous.store(true, Ordering::Relaxed);
            }
            watched
        };

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(POLL_INTERVAL);
            loop {
                interval.tick().await;
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let path = local_path.clone();
                let current = tokio::task::spawn_blocking(move || Signature::of(&path))
                    .await
                    .ok()
                    .flatten();
                let Some(current) = current else { continue };
                if last == Some(current) {
                    continue;
                }
                last = Some(current);
                let _ = app.emit(
                    "openWith:changed",
                    serde_json::json!({ "id": id, "revision": current.revision() }),
                );
            }
        });
    }

    /// Records that `revision` of the copy is now on the server. A later
    /// revision stays unsynced, and the watcher reports it on its own.
    pub fn mark_synced(&self, id: &str, revision: &str) -> bool {
        let Some(signature) = Signature::parse(revision) else {
            return false;
        };
        let mut state = self.inner.lock().unwrap();
        let Some(record) = state.manifest.copies.get_mut(id) else {
            return false;
        };
        record.synced = Some(signature);
        Self::persist(&state);
        true
    }

    /// Stops watching. The copy and its record stay: the external app may
    /// still hold it open, and unsynced edits in it must outlive the watch.
    pub fn stop(&self, id: &str) {
        if let Some(stop) = self.inner.lock().unwrap().polls.remove(id) {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Stops every watcher during application shutdown. The coordinator then
    /// hands the session directory to [`super::edit_recovery`].
    pub fn stop_all(&self) {
        for (_, stop) in self.inner.lock().unwrap().polls.drain() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> (PathBuf, OpenWithWatchers) {
        let dir = std::env::temp_dir().join(format!("ftpeach-open-with-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), OpenWithWatchers::new(dir))
    }

    fn edit(path: &Path, content: &[u8]) {
        std::fs::write(path, content).unwrap();
        // Filesystems with coarse timestamps still see the length change.
    }

    #[test]
    fn a_revision_token_round_trips() {
        let signature = Signature {
            secs: 1_700_000_000,
            nanos: 5,
            len: 42,
        };
        assert_eq!(Signature::parse(&signature.revision()), Some(signature));
        assert_eq!(Signature::parse("garbage"), None);
    }

    #[test]
    fn the_first_save_after_opening_counts_as_an_unsynced_edit() {
        let (dir, watchers) = session();
        let file = dir.join("page.html");
        std::fs::write(&file, b"server").unwrap();
        watchers.register("a", file.clone(), "/site/page.html".into());
        assert_eq!(watchers.unsynced_count(), 0);
        let manifest = Manifest::read(&dir).unwrap();
        assert!(!manifest.copies["a"].has_unsynced_edits());

        edit(&file, b"edited by the user");
        assert_eq!(watchers.unsynced_count(), 1);
        watchers.stop("a");
        assert_eq!(watchers.unsynced_count(), 1);
        let manifest = Manifest::read(&dir).unwrap();
        assert!(manifest.copies["a"].has_unsynced_edits());
        assert_eq!(manifest.copies["a"].remote_path, "/site/page.html");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_the_uploaded_revision_becomes_synced() {
        let (dir, watchers) = session();
        let file = dir.join("notes.txt");
        std::fs::write(&file, b"v1").unwrap();
        watchers.register("a", file.clone(), "/notes.txt".into());

        edit(&file, b"v2 edited");
        let uploaded = Signature::of(&file).unwrap().revision();
        edit(&file, b"v3 edited again while uploading");
        assert!(watchers.mark_synced("a", &uploaded));
        assert!(Manifest::read(&dir).unwrap().copies["a"].has_unsynced_edits());

        let latest = Signature::of(&file).unwrap().revision();
        assert!(watchers.mark_synced("a", &latest));
        assert_eq!(watchers.unsynced_count(), 0);
        assert!(!Manifest::read(&dir).unwrap().copies["a"].has_unsynced_edits());
        assert!(!watchers.mark_synced("missing", &latest));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stopping_a_watch_keeps_the_record() {
        let (dir, watchers) = session();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        watchers.register("a", file, "/a.txt".into());
        watchers.stop("a");
        watchers.stop_all();
        assert!(Manifest::read(&dir).unwrap().copies.contains_key("a"));
        watchers.forget("a");
        assert!(Manifest::read(&dir).unwrap().copies.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
