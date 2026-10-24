use super::*;

/// The provenance a download carries; these tests are about the
/// artifact lifecycle, not about which zone it came from.
fn test_origin() -> crate::local_fs::provenance::Origin {
    crate::local_fs::provenance::Origin::for_url("sftp://files.example.com", "/file")
}

fn identity(size: Option<u64>, version: Option<&str>) -> SourceIdentity {
    SourceIdentity {
        endpoint: "server".into(),
        remote_path: "/file".into(),
        size,
        version: version.map(str::to_owned),
    }
}

/// A fresh directory and the destination a download writes in it.
fn scratch() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("ftpeach-life-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("file.bin");
    (root, destination)
}

async fn start(
    destination: &Path,
    resume: bool,
    source: SourceIdentity,
) -> Result<Option<LocalDownload>> {
    DownloadTarget::reserve(destination)
        .await?
        .prepare(resume, source, test_origin())
        .await
}

/// A download that has something left to transfer.
async fn begin(destination: &Path, resume: bool, source: SourceIdentity) -> LocalDownload {
    start(destination, resume, source)
        .await
        .unwrap()
        .expect("a partial that is not complete yet")
}

/// Writes `bytes` the way a transport does and reports the total length.
async fn write(download: &LocalDownload, offset: u64, bytes: &[u8]) -> Result<u64> {
    use tokio::io::AsyncWriteExt;
    let mut file = download.open_at(offset).await?;
    file.write_all(bytes).await?;
    file.flush().await?;
    Ok(offset + bytes.len() as u64)
}

async fn cancel(download: LocalDownload) {
    let result = download
        .finish(Err(anyhow::anyhow!("cancelled")), None)
        .await;
    assert!(result.is_err());
}

/// Leaves half of an 8-byte "v1" download behind, as a cancel does.
async fn leave_half(destination: &Path) {
    let download = begin(destination, true, identity(Some(8), Some("v1"))).await;
    write(&download, 0, b"half").await.unwrap();
    cancel(download).await;
}

/// Finishes without consent to replace an existing destination.
async fn finish(
    download: LocalDownload,
    written: Result<u64>,
    expected: Option<u64>,
) -> Result<()> {
    crate::protocol::ALLOW_OVERWRITE
        .scope(false, download.finish(written, expected))
        .await
}

#[tokio::test]
async fn a_download_lifecycle_writes_resumes_and_commits_once() {
    let (root, destination) = scratch();
    let source = identity(Some(8), Some("v1"));

    // Fresh, then cancelled halfway: the partial stays for a resume.
    let download = begin(&destination, true, source.clone()).await;
    assert_eq!(download.start(), 0);
    write(&download, 0, b"half").await.unwrap();
    cancel(download).await;
    assert!(!destination.exists());
    assert_eq!(resumable_len(&destination), Some(4));

    // Resumed from the same source, and committed.
    let download = begin(&destination, true, source).await;
    assert_eq!(download.start(), 4);
    let written = write(&download, 4, b"done").await;
    finish(download, written, Some(8)).await.unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"halfdone");
    assert_eq!(resumable_len(&destination), None);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_discarded_download_leaves_nothing_behind() {
    let (root, destination) = scratch();
    leave_half(&destination).await;
    discard(&destination).await;
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_discard_with_nothing_kept_leaves_the_downloaded_file() {
    let (root, destination) = scratch();
    std::fs::write(&destination, b"done").unwrap();
    discard(&destination).await;
    assert_eq!(std::fs::read(&destination).unwrap(), b"done");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn access_denied_on_a_file_nobody_holds_stays_access_denied() {
    let (root, destination) = scratch();
    std::fs::write(&destination, b"old").unwrap();
    let error = held_by_another_program(std::io::Error::from_raw_os_error(5), &destination);
    assert_eq!(error.raw_os_error(), Some(5));
    std::fs::remove_dir_all(root).unwrap();
}

/// Opens `path` as a virus scanner might, without sharing delete, and
/// lets go of it a second later.
#[cfg(windows)]
fn hold_for_a_second(path: &Path) -> std::thread::JoinHandle<()> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ
        .open(path)
        .unwrap();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        drop(file);
    })
}

#[cfg(windows)]
#[tokio::test]
async fn a_record_or_partial_held_for_a_moment_is_still_committed_and_cleaned_up() {
    let (root, destination) = scratch();
    let source = identity(Some(8), Some("v1"));

    // The record, held as the download commits, cannot even be read.
    let download = begin(&destination, true, source.clone()).await;
    let written = write(&download, 0, b"complete").await;
    let held = hold_for_a_second(&sidecar(&destination));
    finish(download, written, Some(8)).await.unwrap();
    held.join().unwrap();
    assert!(!sidecar(&destination).exists());

    // The partial, held as it is flushed and renamed.
    std::fs::remove_file(&destination).unwrap();
    let download = begin(&destination, true, source).await;
    let written = write(&download, 0, b"complete").await;
    let held = hold_for_a_second(&download.partial);
    finish(download, written, Some(8)).await.unwrap();
    held.join().unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
    assert!(!sidecar(&destination).exists());

    // A paused download's partial, held as it resumes: resumed, not
    // given up for a new partial that the record would name instead.
    std::fs::remove_file(&destination).unwrap();
    leave_half(&destination).await;
    let record = read_record(&sidecar(&destination)).unwrap();
    let held = hold_for_a_second(&artifact_path(&destination, record.artifact));
    let download = begin(&destination, true, identity(Some(8), Some("v1"))).await;
    held.join().unwrap();
    assert_eq!(download.start(), 4);
    cancel(download).await;
    assert_eq!(
        read_record(&sidecar(&destination)).unwrap().artifact,
        record.artifact
    );

    // A stopped download's partial, held as it is discarded: removed,
    // and its record only after it.
    let record = read_record(&sidecar(&destination)).unwrap();
    let held = hold_for_a_second(&artifact_path(&destination, record.artifact));
    discard(&destination).await;
    held.join().unwrap();
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_download_that_gets_nothing_leaves_nothing_behind() {
    let (root, destination) = scratch();
    // Refused before its first byte, as a file deleted on the server is.
    cancel(begin(&destination, true, identity(None, None)).await).await;
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    // A later attempt that gets nothing keeps what an earlier one left to resume.
    leave_half(&destination).await;
    cancel(begin(&destination, true, identity(Some(8), Some("v1"))).await).await;
    assert_eq!(resumable_len(&destination), Some(4));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_complete_partial_commits_without_a_transfer() {
    let (root, destination) = scratch();
    let source = identity(Some(8), Some("v1"));
    let download = begin(&destination, true, source.clone()).await;
    write(&download, 0, b"complete").await.unwrap();
    // Cancelled after the last byte, before the commit.
    cancel(download).await;
    let next = crate::protocol::ALLOW_OVERWRITE
        .scope(false, start(&destination, true, source))
        .await
        .unwrap();
    assert!(next.is_none());
    assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn an_unknown_size_or_changed_source_starts_over_and_is_never_treated_as_zero() {
    let (root, destination) = scratch();
    leave_half(&destination).await;
    for changed in [identity(None, Some("v1")), identity(Some(8), Some("v2"))] {
        let download = begin(&destination, true, changed).await;
        assert_eq!(download.start(), 0);
        cancel(download).await;
    }
    // Unknown size: whatever arrives is the file, an empty one included.
    let download = begin(&destination, false, identity(None, None)).await;
    let written = write(&download, 0, b"").await;
    finish(download, written, None).await.unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_short_download_or_a_refused_commit_keeps_the_old_file() {
    let (root, destination) = scratch();
    std::fs::write(&destination, b"old").unwrap();
    for (bytes, what) in [(&b"short"[..], "short"), (&b"complete"[..], "no consent")] {
        let download = begin(&destination, false, identity(Some(8), None)).await;
        let written = write(&download, 0, bytes).await;
        assert!(finish(download, written, Some(8)).await.is_err(), "{what}");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old", "{what}");
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn the_destination_stays_reserved_until_the_commit() {
    let (root, destination) = scratch();
    let download = begin(&destination, false, identity(Some(4), None)).await;
    // A second download of the same target is refused as busy, and so is
    // a local move or delete of it or its folder.
    assert!(DownloadTarget::reserve(&destination).await.is_err());
    assert!(
        crate::local_fs::target_reservation::Reservation::acquire(&root.to_string_lossy()).is_err()
    );
    // Moves and deletes elsewhere do not wait for the bytes to arrive.
    drop(
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            crate::local_fs::mutations::guard().write(),
        )
        .await
        .expect("a download between its path steps holds no lock"),
    );
    let written = write(&download, 0, b"data").await;
    finish(download, written, Some(4)).await.unwrap();
    assert!(DownloadTarget::reserve(&destination).await.is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn sibling_downloads_in_one_recursive_operation_cannot_share_metadata() {
    crate::local_fs::target_reservation::OWNER
        .scope("same-operation".into(), async {
            let target = std::env::temp_dir().join(format!("same-owner-{}", uuid::Uuid::new_v4()));
            let _first = reserve(&target).unwrap();
            assert!(reserve(&target).is_err());
            assert!(reserve(&sidecar(&target)).is_err());
        })
        .await;
}

#[test]
fn downloads_reserve_their_resume_metadata_as_well_as_the_target() {
    let root = std::env::temp_dir().join(format!("reservation-{}", uuid::Uuid::new_v4()));
    let target = root.join("file");
    let first = reserve(&target).unwrap();
    assert!(reserve(&target).is_err());
    assert!(reserve(&sidecar(&target)).is_err());
    let independent = reserve(&root.join("other")).unwrap();
    drop(first);
    assert!(reserve(&target).is_ok());
    drop(independent);
}

#[tokio::test]
async fn resume_requires_the_same_endpoint_path_size_and_version() {
    let root = std::env::temp_dir().join(format!("ftpeach-resume-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("file.bin");
    let source = SourceIdentity {
        endpoint: "server-a:user".into(),
        remote_path: "/file".into(),
        size: Some(8),
        version: Some("v1".into()),
    };
    std::fs::write(partial_path(&destination), b"foreign!").unwrap();
    let (path, start) = prepare(&destination, true, source.clone(), test_origin())
        .await
        .unwrap();
    assert_eq!(start, 0);
    assert_ne!(path, partial_path(&destination));
    std::fs::write(&path, b"half").unwrap();
    assert_eq!(
        prepare(&destination, true, source.clone(), test_origin())
            .await
            .unwrap(),
        (path.clone(), 4)
    );
    for changed in [
        SourceIdentity {
            endpoint: "server-b:user".into(),
            ..source.clone()
        },
        SourceIdentity {
            version: Some("v2".into()),
            ..source.clone()
        },
        SourceIdentity {
            version: None,
            ..source.clone()
        },
    ] {
        let (complete, _) = prepare(&destination, false, source.clone(), test_origin())
            .await
            .unwrap();
        std::fs::write(&complete, b"old-data").unwrap();
        let (fresh, offset) = prepare(&destination, true, changed, test_origin())
            .await
            .unwrap();
        assert_eq!(offset, 0);
        assert_ne!(fresh, path);
        assert_ne!(fresh, complete);
    }
    assert_eq!(
        std::fs::read(partial_path(&destination)).unwrap(),
        b"foreign!"
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"half");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn linked_resume_artifact_is_never_opened_for_writing() {
    let root = std::env::temp_dir().join(format!("ftpeach-links-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("file.bin");
    let source = SourceIdentity {
        endpoint: "server".into(),
        remote_path: "/file".into(),
        size: Some(8),
        version: Some("v1".into()),
    };
    let (partial, _) = prepare(&destination, false, source.clone(), test_origin())
        .await
        .unwrap();
    std::fs::write(&partial, b"keep").unwrap();
    std::fs::hard_link(&partial, root.join("user-file")).unwrap();
    assert!(open_artifact(&partial, false).is_err());
    let (fresh, offset) = prepare(&destination, true, source, test_origin())
        .await
        .unwrap();
    assert_eq!(offset, 0);
    assert_ne!(fresh, partial);
    assert_eq!(std::fs::read(root.join("user-file")).unwrap(), b"keep");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_committed_download_forgets_only_its_own_resume_record() {
    let root = std::env::temp_dir().join(format!("ftpeach-resume-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("file.bin");
    let source = SourceIdentity {
        endpoint: "server".into(),
        remote_path: "/file".into(),
        size: Some(8),
        version: Some("v1".into()),
    };
    let (partial, _) = prepare(&destination, false, source.clone(), test_origin())
        .await
        .unwrap();
    std::fs::write(&partial, b"complete").unwrap();
    crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&partial, &destination))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
    assert!(!sidecar(&destination).exists());
    // A local copy committing its own temporary leaves a download's record be.
    let (downloading, _) = prepare(&destination, false, source, test_origin())
        .await
        .unwrap();
    let copied = root.join(".ftpeach-copy.part");
    std::fs::write(&copied, b"replaced").unwrap();
    crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&copied, &destination))
        .await
        .unwrap();
    assert!(sidecar(&destination).exists());
    assert!(downloading.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "Requires Windows Developer Mode or SeCreateSymbolicLinkPrivilege; run explicitly on a privileged fixture host"]
fn artifact_symlink_cannot_write_to_its_target() {
    let root = std::env::temp_dir().join(format!("ftpeach-symlink-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let target = root.join("user-file");
    let link = root.join("artifact.part");
    std::fs::write(&target, b"keep").unwrap();
    std::os::windows::fs::symlink_file(&target, &link).unwrap();
    assert!(open_artifact(&link, false).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    std::fs::remove_file(&link).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn no_replace_commit_preserves_a_target_created_after_preflight() {
    let root = std::env::temp_dir().join(format!("ftpeach-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("file");
    let partial = root.join("partial");
    std::fs::write(&partial, b"new").unwrap();
    std::fs::write(&destination, b"racing writer").unwrap();
    // Missing task-local consent must be just as safe as explicit refusal.
    assert!(commit(&partial, &destination).await.is_err());
    assert!(
        crate::protocol::ALLOW_OVERWRITE
            .scope(false, commit(&partial, &destination))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&destination).unwrap(), b"racing writer");
    assert_eq!(std::fs::read(&partial).unwrap(), b"new");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_before_commit_leaves_old_destination_and_recoverable_partial() {
    const FIXTURE: &str = "FTPEACH_P0_COMMIT_FIXTURE";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let destination = PathBuf::from(root).join("report.txt");
        let partial = partial_path(&destination);
        let mut file = std::fs::File::create(partial).unwrap();
        std::io::Write::write_all(&mut file, b"verified").unwrap();
        file.sync_all().unwrap();
        // Simulate process loss after the completed partial was flushed.
        // Native replacement has no user-space backup/restore interval.
        std::process::exit(73);
    }
    let root = std::env::temp_dir().join(format!("ftpeach-interrupted-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("report.txt");
    std::fs::write(&destination, b"old").unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "protocol::transfer_file::tests::interrupted_before_commit_leaves_old_destination_and_recoverable_partial"])
        .env(FIXTURE, &root).status().unwrap();
    assert_eq!(status.code(), Some(73));
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    let partial = partial_path(&destination);
    assert_eq!(std::fs::read(&partial).unwrap(), b"verified");
    crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&partial, &destination))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"verified");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn a_file_another_program_holds_is_reported_in_use_not_forbidden() {
    use std::os::windows::fs::OpenOptionsExt;
    let (root, destination) = scratch();
    let partial = partial_path(&destination);
    std::fs::write(&destination, b"old").unwrap();
    std::fs::write(&partial, b"new").unwrap();
    // Shares reading and writing but not delete, as Word does.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1 | 2)
        .open(&destination)
        .unwrap();
    let error = crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&partial, &destination))
        .await
        .unwrap_err();
    assert_eq!(
        crate::ipc::CommandError::from(error).code,
        crate::ipc::ErrorCode::FileInUse
    );
    drop(held);
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn commit_preserves_user_backup_names_and_independent_extensions() {
    let root = std::env::temp_dir().join(format!("ftpeach-commit-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(root.join("report.ftpeach-old"), b"user backup")
        .await
        .unwrap();
    for name in ["report.txt", "report.csv"] {
        let destination = root.join(name);
        let partial = partial_path(&destination);
        tokio::fs::write(&destination, b"old").await.unwrap();
        tokio::fs::write(&partial, name.as_bytes()).await.unwrap();
        crate::protocol::ALLOW_OVERWRITE
            .scope(true, commit(&partial, &destination))
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(destination).await.unwrap(), name.as_bytes());
        assert_eq!(
            tokio::fs::read(root.join("report.ftpeach-old"))
                .await
                .unwrap(),
            b"user backup"
        );
    }
    let destination = root.join("report.ftpeach-old");
    let partial = partial_path(&destination);
    tokio::fs::write(&partial, b"new backup").await.unwrap();
    crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&partial, &destination))
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"new backup");
    assert!(commit(&root.join("missing"), &destination).await.is_err());
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"new backup");
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn failed_native_replace_keeps_both_old_file_and_verified_partial() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = std::env::temp_dir().join(format!("ftpeach-commit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let destination = root.join("locked.txt");
    let partial = partial_path(&destination);
    std::fs::write(&destination, b"old").unwrap();
    std::fs::write(&partial, b"verified").unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&destination)
        .unwrap();
    assert!(
        crate::protocol::ALLOW_OVERWRITE
            .scope(true, commit(&partial, &destination))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    assert_eq!(std::fs::read(&partial).unwrap(), b"verified");
    drop(lock);
    crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&partial, &destination))
        .await
        .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn partial_is_a_sibling_with_stable_suffix() {
    assert_eq!(
        partial_path(Path::new("C:/tmp/file.bin")),
        PathBuf::from("C:/tmp/file.bin.ftpeach-part")
    );
}

#[test]
fn known_zero_is_not_unknown() {
    assert!(validate_length(0, Some(0)).is_ok());
    assert!(validate_length(1, None).is_ok());
    assert!(validate_length(0, Some(1)).is_err());
    assert!(validate_resume_offset(2, Some(1)).is_err());
}

#[tokio::test]
async fn verified_partial_replaces_destination() {
    let root = std::env::temp_dir().join(format!("ftpeach-partial-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let destination = root.join("file.bin");
    let partial = partial_path(&destination);
    tokio::fs::write(&destination, b"old").await.unwrap();
    tokio::fs::write(&partial, b"verified").await.unwrap();
    crate::protocol::ALLOW_OVERWRITE
        .scope(true, commit(&partial, &destination))
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"verified");
    assert!(tokio::fs::metadata(&partial).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn complete_partial_is_committed_without_another_transfer() {
    let root = std::env::temp_dir().join(format!("ftpeach-complete-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let destination = root.join("file.bin");
    let partial = partial_path(&destination);
    tokio::fs::write(&partial, b"complete").await.unwrap();

    assert!(
        commit_if_complete(&partial, &destination, 8, Some(8))
            .await
            .unwrap()
    );
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"complete");
    assert!(tokio::fs::metadata(&partial).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}

/// A damaged or edited resume record resumes from its own partial or
/// from nothing, never from another file.
#[test]
fn generated_resume_records_resume_only_their_own_partial() {
    let (root, destination) = scratch();
    let artifact = uuid::Uuid::new_v4();
    std::fs::write(artifact_path(&destination, artifact), b"partial").unwrap();
    std::fs::write(root.join("outside.txt"), b"not a partial").unwrap();
    let example = serde_json::to_value(ResumeRecord {
        source: identity(Some(7), Some("v1")),
        artifact,
    })
    .unwrap();
    let keys = ["source", "artifact", "endpoint", "remote_path", "size"];
    for value in crate::test_inputs::variants(&example, &keys, 0x5ec0_4d00, 2_000) {
        std::fs::write(sidecar(&destination), serde_json::to_vec(&value).unwrap()).unwrap();
        if let Some(len) = resumable_len(&destination) {
            assert_eq!(len, 7, "{value}");
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

/// Only a whole read, or one of the wrong length, asks the server again; a
/// version is compared when both answers have one, the size always.
#[tokio::test]
async fn a_read_is_kept_only_while_the_server_still_describes_the_same_file() {
    let code =
        |result: Result<u64>| crate::ipc::CommandError::from_anyhow(&result.unwrap_err()).code;
    let before = identity(Some(5), Some("v1"));
    let same = || async { identity(Some(5), Some("v1")) };
    let never = || async { unreachable!("a failed read does not ask the server again") };
    assert_eq!(unless_changed(Ok(5), &before, same).await.unwrap(), 5);
    let saved = || async { identity(Some(5), Some("v2")) };
    assert_eq!(
        code(unless_changed(Ok(5), &before, saved).await),
        ErrorCode::RemoteChanged
    );
    let size_only = || async { identity(Some(6), None) };
    assert_eq!(
        code(unless_changed(Ok(5), &before, size_only).await),
        ErrorCode::RemoteChanged
    );
    let lost = || Err(fail(ErrorCode::ConnectionLost, "lost"));
    assert_eq!(
        code(unless_changed(lost(), &before, never).await),
        ErrorCode::ConnectionLost
    );
    let short = || Err(fail(ErrorCode::IntegrityMismatch, "short"));
    let silent = || async { identity(None, None) };
    assert_eq!(
        code(unless_changed(short(), &before, silent).await),
        ErrorCode::IntegrityMismatch
    );
    assert_eq!(
        code(unless_changed(short(), &before, size_only).await),
        ErrorCode::RemoteChanged
    );
    // No answer the second time, or only part of it: a whole read is kept.
    assert_eq!(unless_changed(Ok(5), &before, silent).await.unwrap(), 5);
    let version_only = || async { identity(None, Some("v1")) };
    assert_eq!(
        unless_changed(Ok(5), &before, version_only).await.unwrap(),
        5
    );
    assert_eq!(
        unless_changed(Ok(5), &identity(None, None), never)
            .await
            .unwrap(),
        5
    );
}
