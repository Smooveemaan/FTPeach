use super::*;
use crate::local_fs::open_with::OpenWithWatchers;

#[test]
fn retention_budget_blocks_new_opens_without_deleting_existing_work() {
    let fixture = Fixture::new();
    let file = fixture.download("edited.txt", b"keep every byte");
    assert!(check_budget(&[&fixture.session], 4, MAX_RETAINED_AGE).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"keep every byte");
    assert!(check_budget(&[&fixture.session], 1024, MAX_RETAINED_AGE).is_ok());
    let old = std::time::SystemTime::now() - MAX_RETAINED_AGE - std::time::Duration::from_secs(1);
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
            std::fs::read(&recovered[0].file).unwrap(),
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
        std::fs::read(&entries(&fixture.root)[0].file).unwrap(),
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
        std::fs::read(&entries(&fixture.root)[0].file).unwrap(),
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
        std::fs::read(&entries(&fixture.root)[0].file).unwrap(),
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
        std::fs::read(&entries(&fixture.root)[0].file).unwrap(),
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
        let base = std::env::temp_dir().join(format!("ftpeach-recovery-{}", uuid::Uuid::new_v4()));
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
    assert_eq!(
        std::fs::read(&entries(&fixture.root)[0].file).unwrap(),
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
fn an_interrupted_download_is_not_recovered_as_an_edit() {
    let fixture = Fixture::new();
    let file = fixture.download(&format!(".ftpeach-{}.part", uuid::Uuid::new_v4()), b"half");
    let folder = file.parent().unwrap();
    std::fs::write(folder.join("song.flac.ftpeach-resume.json"), b"{}").unwrap();
    std::fs::write(
        folder.join(format!(".ftpeach-{}.json", uuid::Uuid::new_v4())),
        b"{}",
    )
    .unwrap();
    std::fs::write(folder.join(".ftpeach-notes.part"), b"a server file").unwrap();

    collect(&fixture.session, &fixture.root).unwrap();

    let edits = list(&fixture.root);
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].name, ".ftpeach-notes.part");
    assert!(!fixture.session.exists());
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

// The file may carry any name the server gave it, the description's own
// in any case included (Windows names ignore case).
#[test]
fn a_file_named_like_the_description_is_recovered_and_readable() {
    for name in ["edit.json", "EDIT.JSON", "Edit.Json", "file"] {
        let fixture = Fixture::new();
        let watchers = OpenWithWatchers::new(fixture.session.clone());
        let file = fixture.download(name, b"{}");
        watchers.register("a", file.clone(), format!("/{name}"));
        std::fs::write(&file, br#"{"unsaved":true}"#).unwrap();

        collect(&fixture.session, &fixture.root).unwrap();

        assert!(!file.exists(), "{name}");
        let found = entries(&fixture.root);
        assert_eq!(found.len(), 1, "{name}");
        assert_eq!(found[0].edit.name, name);
        assert_eq!(found[0].edit.remote_path, Some(format!("/{name}")));
        assert_eq!(
            std::fs::read(&found[0].file).unwrap(),
            br#"{"unsaved":true}"#
        );
        discard(&fixture.root).unwrap();
        assert!(list(&fixture.root).is_empty());
    }
}

#[test]
fn copies_saved_by_earlier_versions_are_still_listed() {
    let fixture = Fixture::new();
    let folder = fixture.root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join(DESCRIPTION),
        br#"{"name":"old.txt","remotePath":"/old.txt","savedAt":"2026-09-01T00:00:00+00:00"}"#,
    )
    .unwrap();
    std::fs::write(folder.join("old.txt"), b"saved beside its description").unwrap();

    let found = entries(&fixture.root);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].edit.remote_path.as_deref(), Some("/old.txt"));
    assert_eq!(
        std::fs::read(&found[0].file).unwrap(),
        b"saved beside its description"
    );
}

#[test]
fn a_legacy_payload_that_parses_as_metadata_stays_visible() {
    for name in ["edit.json", "EDIT.JSON"] {
        let fixture = Fixture::new();
        let folder = fixture.root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&folder).unwrap();
        let content = br#"{"name":"missing.txt","remotePath":"/missing.txt","savedAt":"2026-09-24","userData":"edited copy"}"#;
        std::fs::write(folder.join(name), content).unwrap();
        let found = entries(&fixture.root);
        assert_eq!(found.len(), 1, "{name}");
        assert_eq!(found[0].edit.name, name);
        assert_eq!(found[0].edit.remote_path, None);
        assert_eq!(std::fs::read(&found[0].file).unwrap(), content);
        discard(&fixture.root).unwrap();
        assert!(!folder.exists());
    }
}

// Before the file had a folder of its own, an `edit.json` replaced its
// description. Such a copy, or one whose description is lost or names a
// file that is not there, stays listed so it can be found and discarded.
#[test]
fn a_copy_with_a_damaged_description_stays_listed() {
    let fixture = Fixture::new();
    let overwritten = fixture.root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&overwritten).unwrap();
    std::fs::write(overwritten.join(DESCRIPTION), br#"{"unsaved":true}"#).unwrap();
    let mismatched = fixture.root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(mismatched.join(PAYLOAD)).unwrap();
    std::fs::write(
        mismatched.join(DESCRIPTION),
        br#"{"name":"gone.txt","remotePath":"/gone.txt","savedAt":"x"}"#,
    )
    .unwrap();
    std::fs::write(mismatched.join(PAYLOAD).join("kept.txt"), b"kept").unwrap();
    let empty = fixture.root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&empty).unwrap();

    let mut found: Vec<_> = entries(&fixture.root)
        .into_iter()
        .map(|found| {
            (
                found.edit.name,
                found.edit.remote_path,
                std::fs::read(found.file).unwrap(),
            )
        })
        .collect();
    found.sort();
    assert_eq!(
        found,
        [
            ("edit.json".into(), None, br#"{"unsaved":true}"#.to_vec()),
            ("kept.txt".into(), None, b"kept".to_vec()),
        ]
    );
    discard(&fixture.root).unwrap();
    assert!(!overwritten.exists() && !mismatched.exists());
    assert!(empty.exists(), "a folder with nothing in it is not listed");
}

/// Whatever a damaged or edited description says, the edit listed is a
/// file inside its own folder.
#[test]
fn generated_descriptions_never_list_a_file_outside_the_edit() {
    let fixture = Fixture::new();
    let folder = fixture.root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(folder.join(PAYLOAD)).unwrap();
    std::fs::write(folder.join(PAYLOAD).join("edited.txt"), b"edits").unwrap();
    // What a description pointing out of the folder would find.
    std::fs::write(fixture.root.join("outside.txt"), b"not an edit").unwrap();
    let example = serde_json::to_value(RecoveredEdit {
        name: "edited.txt".into(),
        remote_path: Some("/edited.txt".into()),
        saved_at: "2026-10-15T00:00:00Z".into(),
    })
    .unwrap();
    let keys = ["name", "remotePath", "savedAt"];
    for value in crate::test_inputs::variants(&example, &keys, 0xed17_0000, 2_000) {
        std::fs::write(
            folder.join(DESCRIPTION),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let found = entries(&fixture.root);
        assert_eq!(found.len(), 1, "{value}");
        assert!(
            found[0].file.starts_with(&folder),
            "{value}: listed outside the edit: {:?}",
            found[0].file
        );
    }
    std::fs::remove_dir_all(&fixture.base).unwrap();
}
