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
const MAX_RETAINED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RETAINED_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// Retention is enforced at admission, never by deleting the only edited copy.
/// Existing editors may grow their files beyond the budget; new opens then
/// stop until the user has saved or explicitly discarded the retained work.
pub fn check_admission(session: &Path, root: &Path) -> anyhow::Result<()> {
    let sessions = session
        .parent()
        .ok_or_else(|| std::io::Error::other("No edit session root"))?;
    check_budget(&[sessions, root], MAX_RETAINED_BYTES, MAX_RETAINED_AGE)
}

fn check_budget(
    roots: &[&Path],
    max_bytes: u64,
    max_age: std::time::Duration,
) -> anyhow::Result<()> {
    let mut pending: Vec<(PathBuf, usize)> =
        roots.iter().map(|root| (root.to_path_buf(), 0)).collect();
    let mut bytes = 0u64;
    let mut count = 0usize;
    while let Some((folder, depth)) = pending.pop() {
        let entries = match std::fs::read_dir(folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let kind = entry.file_type()?;
            count += 1;
            if count > 10_000 || depth > 4 {
                return Err(retention_limit());
            }
            if kind.is_symlink() {
                return Err(retention_limit());
            }
            if kind.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                let metadata = entry.metadata()?;
                bytes = bytes.saturating_add(metadata.len());
                let age = metadata.modified()?.elapsed().unwrap_or_default();
                if bytes >= max_bytes || age >= max_age {
                    return Err(retention_limit());
                }
            }
        }
    }
    Ok(())
}

fn retention_limit() -> anyhow::Error {
    crate::ipc::CommandError::new(
        crate::ipc::ErrorCode::ResourceLimit,
        "Save or discard recovered editor copies before opening more files (1 GiB or 30 days). Existing edits have been kept.",
    ).into()
}

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
pub fn data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Windows KnownFolder APIs do not necessarily honor the process's
    // LOCALAPPDATA override. Smoke must never use the interactive user's data.
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
        return std::env::var_os("LOCALAPPDATA")
            .map(|path| PathBuf::from(path).join("com.smooveemaan.ftpeach"));
    }
    use tauri::Manager;
    app.path().app_local_data_dir().ok()
}

pub fn root(app: &tauri::AppHandle) -> Option<PathBuf> {
    data_dir(app).map(|dir| dir.join("recovered-edits"))
}

fn is_session_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
}

/// Files a session left without a manifest: every regular file in its
/// per-download folders. Without a record nothing proves them unedited.
fn unrecorded_files(session: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for folder in std::fs::read_dir(session)? {
        let folder = folder?;
        let kind = folder.file_type()?;
        if kind.is_dir() && !kind.is_symlink() {
            for file in std::fs::read_dir(folder.path())? {
                let file = file?;
                if file.file_type()?.is_file() {
                    found.push(file.path());
                }
            }
        }
    }
    Ok(found)
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
    // A live editor may keep writing. Never copy it and then forget its
    // original: that would lose saves made after the snapshot. If rename is
    // denied, retain the original plus manifest and retry on the next start.
    let destination = folder.join(name);
    let saved = std::fs::write(folder.join(DESCRIPTION), serde_json::to_vec(&description)?)
        .and_then(|()| {
            let result = std::fs::rename(file, &destination);
            #[cfg(windows)]
            if result
                .as_ref()
                .is_err_and(|error| error.raw_os_error() == Some(17))
            {
                return super::verified_move::copy_verify_delete(file, &destination, false)
                    .map_err(std::io::Error::other);
            }
            result
        });
    if saved.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
    }
    saved
}

/// A baseline match by path is not enough: an editor could write between
/// that check and deletion. Hold a handle denying writers/deletion, check
/// its metadata, then delete that very handle. A live writer is recovered.
#[cfg(windows)]
fn remove_if_clean(copy: &super::open_with::CopyRecord) -> std::io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .access_mode(0x80010000)
        .share_mode(1)
        .custom_flags(0x00200000)
        .open(&copy.local_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) if matches!(error.raw_os_error(), Some(32) | Some(33)) => return Ok(false),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || super::filesystem_safety::is_reparse_point(&metadata) {
        return Err(std::io::Error::other("not a regular editor copy"));
    }
    if copy.synced != Some(super::open_with::Signature::from_metadata(&metadata)) {
        return Ok(false);
    }
    super::verified_move::disposition(&file).map_err(std::io::Error::other)?;
    Ok(true)
}

#[cfg(not(windows))]
fn remove_if_clean(copy: &super::open_with::CopyRecord) -> std::io::Result<bool> {
    // Without the native exclusion contract, retain even a seemingly clean copy.
    Ok(
        matches!(std::fs::metadata(&copy.local_path), Err(error) if error.kind() == std::io::ErrorKind::NotFound),
    )
}

/// Ends one open-with session directory: edited copies move to `root`, and
/// the directory is removed only once every one of them is safe there.
pub fn collect(session: &Path, root: &Path) -> std::io::Result<()> {
    let canonical_session = match std::fs::canonicalize(session) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let manifest = match Manifest::read(session) {
        Some(manifest) => manifest,
        None if session.join(MANIFEST).exists() => {
            return Err(std::io::Error::other("unreadable open-with manifest"));
        }
        None => Manifest::default(),
    };
    for copy in manifest.copies.values() {
        if !copy.local_path.starts_with(session) && !copy.local_path.starts_with(&canonical_session)
        {
            return Err(std::io::Error::other("copy outside its session"));
        }
        if !remove_if_clean(copy)? {
            preserve(&copy.local_path, Some(copy.remote_path.clone()), root)?;
        }
    }
    // A failed manifest write must not make the next opened file disposable.
    // Anything left without a record is conservatively recovered as well.
    for file in unrecorded_files(session)? {
        preserve(&file, None, root)?;
    }
    // Emptied first, so a file an editor keeps locked is not collected twice.
    if session.join(MANIFEST).exists() {
        Manifest::default().write(session)?;
    }
    // Remove only empty folders, never recursively sweep an editor's tree:
    // a save-as racing the scan must survive for the next recovery pass.
    for folder in std::fs::read_dir(session)? {
        let folder = folder?;
        if folder.file_type()?.is_dir() {
            std::fs::remove_dir(folder.path())?;
        }
    }
    if session.join(MANIFEST).exists() {
        std::fs::remove_file(session.join(MANIFEST))?;
    }
    std::fs::remove_dir(session)?;
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

    #[test]
    fn retention_budget_blocks_new_opens_without_deleting_existing_work() {
        let fixture = Fixture::new();
        let file = fixture.download("edited.txt", b"keep every byte");
        assert!(check_budget(&[&fixture.session], 4, MAX_RETAINED_AGE).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"keep every byte");
        assert!(check_budget(&[&fixture.session], 1024, MAX_RETAINED_AGE).is_ok());
        let old =
            std::time::SystemTime::now() - MAX_RETAINED_AGE - std::time::Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert!(check_budget(&[&fixture.session], 1024, MAX_RETAINED_AGE).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"keep every byte");
    }

    #[cfg(windows)]
    #[test]
    fn a_live_editor_with_or_without_delete_sharing_keeps_later_saves() {
        use std::io::{Seek, SeekFrom, Write};
        use std::os::windows::fs::OpenOptionsExt;
        for share_delete in [false, true] {
            let fixture = Fixture::new();
            let watchers = OpenWithWatchers::new(fixture.session.clone());
            let file = fixture.download("live.txt", b"server");
            watchers.register("a", file.clone(), "/live.txt".into());
            let mut editor = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(if share_delete { 7 } else { 3 })
                .open(&file)
                .unwrap();
            editor.write_all(b"first edited revision").unwrap();
            editor.sync_all().unwrap();
            watchers.stop_all();
            let collected = collect(&fixture.session, &fixture.root);
            assert_eq!(collected.is_ok(), share_delete);
            // The editor saves again after shutdown. A copied snapshot with
            // a cleared manifest would lose this second save.
            editor.seek(SeekFrom::Start(0)).unwrap();
            editor
                .write_all(b"second revision after application shutdown")
                .unwrap();
            editor.sync_all().unwrap();
            drop(editor);
            if !share_delete {
                assert!(
                    Manifest::read(&fixture.session)
                        .unwrap()
                        .copies
                        .contains_key("a")
                );
                collect(&fixture.session, &fixture.root).unwrap();
            }
            let recovered = entries(&fixture.root);
            assert_eq!(recovered.len(), 1);
            assert_eq!(
                std::fs::read(recovered[0].0.join("live.txt")).unwrap(),
                b"second revision after application shutdown"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_exclusively_locked_edit_and_its_manifest_survive_collection() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download("locked.txt", b"server");
        watchers.register("a", file.clone(), "/locked.txt".into());
        std::fs::write(&file, b"unsaved editor changes").unwrap();
        let editor = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&file)
            .unwrap();
        assert!(collect(&fixture.session, &fixture.root).is_err());
        assert!(
            Manifest::read(&fixture.session)
                .unwrap()
                .copies
                .contains_key("a")
        );
        drop(editor);
        collect(&fixture.session, &fixture.root).unwrap();
        assert_eq!(
            std::fs::read(entries(&fixture.root)[0].0.join("locked.txt")).unwrap(),
            b"unsaved editor changes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_clean_but_open_file_keeps_its_baseline_for_a_later_save() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download("clean.txt", b"server");
        watchers.register("a", file.clone(), "/clean.txt".into());
        let mut editor = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(3)
            .open(&file)
            .unwrap();
        assert!(collect(&fixture.session, &fixture.root).is_err());
        assert!(
            Manifest::read(&fixture.session)
                .unwrap()
                .copies
                .contains_key("a")
        );
        editor
            .write_all(b"saved after the application closed")
            .unwrap();
        editor.sync_all().unwrap();
        drop(editor);
        collect(&fixture.session, &fixture.root).unwrap();
        assert_eq!(
            std::fs::read(entries(&fixture.root)[0].0.join("clean.txt")).unwrap(),
            b"saved after the application closed"
        );
    }

    #[test]
    fn a_partial_manifest_does_not_discard_unrecorded_files() {
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let clean = fixture.download("clean.txt", b"server");
        watchers.register("a", clean, "/clean.txt".into());
        fixture.download("unrecorded.txt", b"edits after a failed manifest write");
        collect(&fixture.session, &fixture.root).unwrap();
        assert_eq!(list(&fixture.root).len(), 1);
        assert_eq!(
            std::fs::read(entries(&fixture.root)[0].0.join("unrecorded.txt")).unwrap(),
            b"edits after a failed manifest write"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_clean_live_writer_with_delete_sharing_is_recovered_instead_of_unlinked() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download("live-clean.txt", b"server");
        watchers.register("a", file.clone(), "/live-clean.txt".into());
        let mut editor = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(7)
            .open(&file)
            .unwrap();
        collect(&fixture.session, &fixture.root).unwrap();
        editor.write_all(b"first save after shutdown").unwrap();
        editor.sync_all().unwrap();
        drop(editor);
        assert_eq!(
            std::fs::read(entries(&fixture.root)[0].0.join("live-clean.txt")).unwrap(),
            b"first save after shutdown"
        );
    }

    #[test]
    fn canonical_paths_returned_by_the_opener_are_recovered() {
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download("canonical.txt", b"server");
        watchers.register(
            "a",
            std::fs::canonicalize(&file).unwrap(),
            "/canonical.txt".into(),
        );
        std::fs::write(&file, b"edited through the canonical opener path").unwrap();
        collect(&fixture.session, &fixture.root).unwrap();
        assert_eq!(list(&fixture.root).len(), 1);
        assert!(!fixture.session.exists());
    }

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
