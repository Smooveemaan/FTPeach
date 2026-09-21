//! Edits made in an external editor that never reached the server. When an
//! open-with session ends, at shutdown or at the next start after a crash,
//! copies that differ from what the server was given move here instead of
//! being deleted with the session's temporary files. They stay until the user
//! discards them; nothing here expires.
//!
//! Each edit gets its own folder holding the file and an `edit.json` naming
//! the server path it came from, so the folder describes itself and no index
//! can fall out of step with the files.
use super::open_with::{MANIFEST, Manifest};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const DESCRIPTION: &str = "edit.json";

/// One recovered edit as the renderer lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredEdit {
    pub name: String,
    /// `None` for a copy left by a version that did not record it.
    pub remote_path: Option<String>,
    pub saved_at: String,
}

/// Where recovered edits live: beside the application's local data, outside
/// the temporary directory that Windows may clean on its own.
pub fn root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("recovered-edits"))
}

fn is_session_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
}

/// Files a session left without a manifest: every regular file in its
/// per-download folders. Without a record nothing proves them unedited.
fn unrecorded_files(session: &Path) -> Vec<PathBuf> {
    let Ok(folders) = std::fs::read_dir(session) else {
        return Vec::new();
    };
    folders
        .flatten()
        .filter(|folder| folder.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|folder| std::fs::read_dir(folder.path()).ok())
        .flat_map(|files| files.flatten())
        .filter(|file| file.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|file| file.path())
        .collect()
}

fn preserve(file: &Path, remote_path: Option<String>, root: &Path) -> std::io::Result<()> {
    let name = file
        .file_name()
        .ok_or_else(|| std::io::Error::other("copy has no file name"))?;
    let folder = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder)?;
    let description = RecoveredEdit {
        name: name.to_string_lossy().into_owned(),
        remote_path,
        saved_at: chrono::Utc::now().to_rfc3339(),
    };
    let saved = std::fs::write(folder.join(DESCRIPTION), serde_json::to_vec(&description)?)
        .and_then(|()| match std::fs::rename(file, folder.join(name)) {
            Ok(()) => Ok(()),
            // Another volume, or an editor holding the file without sharing
            // delete: a copy keeps the edit and leaves the original alone.
            Err(_) => std::fs::copy(file, folder.join(name)).map(|_| ()),
        });
    if saved.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
    }
    saved
}

/// Ends one open-with session directory: edited copies move to `root`, and
/// the directory is removed only once every one of them is safe there.
pub fn collect(session: &Path, root: &Path) -> std::io::Result<()> {
    let edited: Vec<(PathBuf, Option<String>)> = match Manifest::read(session) {
        Some(manifest) => manifest
            .copies
            .into_values()
            .filter(|copy| copy.local_path.starts_with(session) && copy.has_unsynced_edits())
            .map(|copy| (copy.local_path, Some(copy.remote_path)))
            .collect(),
        None if session.join(MANIFEST).exists() => {
            return Err(std::io::Error::other("unreadable open-with manifest"));
        }
        None => unrecorded_files(session)
            .into_iter()
            .map(|path| (path, None))
            .collect(),
    };
    for (file, remote_path) in edited {
        preserve(&file, remote_path, root)?;
    }
    // Emptied first, so a file an editor keeps locked is not collected twice.
    if session.join(MANIFEST).exists() {
        Manifest::default().write(session)?;
    }
    let _ = std::fs::remove_dir_all(session);
    Ok(())
}

/// Collects sessions left by earlier runs. The app is single-instance, so
/// every session directory except the current one is abandoned.
pub fn collect_abandoned(current: &Path, root: &Path) {
    let Some(sessions) = current.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(sessions) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink());
        if path == current || !is_dir || !is_session_name(&path) {
            continue;
        }
        if let Err(error) = collect(&path, root) {
            log::warn!("kept open-with session {}: {error}", path.display());
        }
    }
}

fn entries(root: &Path) -> Vec<(PathBuf, RecoveredEdit)> {
    let Ok(folders) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<_> = folders
        .flatten()
        .map(|folder| folder.path())
        .filter(|folder| is_session_name(folder))
        .filter_map(|folder| {
            let edit: RecoveredEdit =
                serde_json::from_slice(&std::fs::read(folder.join(DESCRIPTION)).ok()?).ok()?;
            folder.join(&edit.name).is_file().then_some((folder, edit))
        })
        .collect();
    found.sort_by(|a, b| a.1.saved_at.cmp(&b.1.saved_at));
    found
}

pub fn list(root: &Path) -> Vec<RecoveredEdit> {
    entries(root).into_iter().map(|(_, edit)| edit).collect()
}

/// Deletes the listed edits, and only them: folders without a description
/// are not this module's to remove.
pub fn discard(root: &Path) -> std::io::Result<()> {
    for (folder, _) in entries(root) {
        std::fs::remove_dir_all(folder)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_fs::open_with::OpenWithWatchers;

    struct Fixture {
        base: PathBuf,
        session: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("ftpeach-recovery-{}", uuid::Uuid::new_v4()));
            let session = base
                .join("ftpeach-openwith")
                .join(uuid::Uuid::new_v4().to_string());
            let root = base.join("recovered-edits");
            std::fs::create_dir_all(&session).unwrap();
            Self {
                base,
                session,
                root,
            }
        }

        fn download(&self, name: &str, content: &[u8]) -> PathBuf {
            let folder = self.session.join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&folder).unwrap();
            let file = folder.join(name);
            std::fs::write(&file, content).unwrap();
            file
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn edited_copies_are_kept_and_untouched_ones_removed() {
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let edited = fixture.download("edited.txt", b"server");
        let untouched = fixture.download("untouched.txt", b"server");
        watchers.register("a", edited.clone(), "/www/edited.txt".into());
        watchers.register("b", untouched, "/www/untouched.txt".into());
        std::fs::write(&edited, b"the user's unsaved work").unwrap();

        collect(&fixture.session, &fixture.root).unwrap();

        assert!(!fixture.session.exists());
        let edits = list(&fixture.root);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].name, "edited.txt");
        assert_eq!(edits[0].remote_path.as_deref(), Some("/www/edited.txt"));
        let (folder, _) = &entries(&fixture.root)[0];
        assert_eq!(
            std::fs::read(folder.join("edited.txt")).unwrap(),
            b"the user's unsaved work"
        );
    }

    #[test]
    fn an_uploaded_revision_is_not_recovered() {
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download("a.txt", b"server");
        watchers.register("a", file.clone(), "/a.txt".into());
        std::fs::write(&file, b"edited and uploaded").unwrap();
        let revision = crate::local_fs::open_with::Signature::of(&file)
            .unwrap()
            .revision();
        assert!(watchers.mark_synced("a", &revision));

        collect(&fixture.session, &fixture.root).unwrap();

        assert!(list(&fixture.root).is_empty());
        assert!(!fixture.session.exists());
    }

    #[test]
    fn a_crashed_session_is_collected_at_the_next_start() {
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download("report.docx", b"server");
        watchers.register("a", file.clone(), "/docs/report.docx".into());
        std::fs::write(&file, b"edited before the crash").unwrap();
        drop(watchers);
        let current = fixture
            .session
            .parent()
            .unwrap()
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&current).unwrap();

        collect_abandoned(&current, &fixture.root);

        assert!(!fixture.session.exists());
        assert!(current.exists(), "the running session is left alone");
        assert_eq!(list(&fixture.root)[0].name, "report.docx");
    }

    #[test]
    fn a_session_without_a_record_keeps_every_file() {
        let fixture = Fixture::new();
        fixture.download("legacy.txt", b"unknown state");

        collect(&fixture.session, &fixture.root).unwrap();

        let edits = list(&fixture.root);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].remote_path, None);
    }

    #[test]
    fn an_unreadable_record_keeps_the_session() {
        let fixture = Fixture::new();
        fixture.download("a.txt", b"x");
        std::fs::write(fixture.session.join(MANIFEST), b"{broken").unwrap();

        assert!(collect(&fixture.session, &fixture.root).is_err());

        assert!(fixture.session.exists());
        assert!(list(&fixture.root).is_empty());
    }

    #[test]
    fn discarding_removes_only_recovered_edits() {
        let fixture = Fixture::new();
        fixture.download("a.txt", b"x");
        collect(&fixture.session, &fixture.root).unwrap();
        let foreign = fixture.root.join("not-ours");
        std::fs::create_dir_all(&foreign).unwrap();

        discard(&fixture.root).unwrap();

        assert!(list(&fixture.root).is_empty());
        assert!(foreign.exists());
    }
}
