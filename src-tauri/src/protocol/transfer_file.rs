//! Shared local-file policy for downloads.

use crate::ipc::ErrorCode;
use crate::protocol::fail;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub const PARTIAL_SUFFIX: &str = ".ftpeach-part";

pub fn partial_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(PARTIAL_SUFFIX);
    destination.with_file_name(name)
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq, Clone)]
pub struct SourceIdentity {
    pub endpoint: String,
    pub remote_path: String,
    pub size: Option<u64>,
    pub version: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ResumeRecord {
    source: SourceIdentity,
    artifact: uuid::Uuid,
}

fn sidecar(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(".ftpeach-resume.json");
    PathBuf::from(name)
}

/// The resume record is another writable destination, so a parallel download
/// cannot select it as its own output while this transfer is using it.
pub fn reserve(destination: &Path) -> Result<DownloadReservation> {
    use crate::local_fs::target_reservation::Reservation;
    let target = Reservation::acquire(&destination.to_string_lossy())?;
    let metadata = Reservation::acquire(&sidecar(destination).to_string_lossy())?;
    let keys = [destination.to_path_buf(), sidecar(destination)]
        .map(|path| crate::local_fs::target_reservation::key(None, &path.to_string_lossy()));
    let mut active = active_downloads().lock().unwrap();
    anyhow::ensure!(
        !keys.iter().any(|key| active.contains(key)),
        "Another download is using this destination or its resume metadata"
    );
    active.extend(keys.iter().cloned());
    Ok(DownloadReservation {
        _leases: (target, metadata),
        keys,
    })
}

fn active_downloads() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static ACTIVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}

/// Root leases can be shared by one recursive operation, but its individual
/// downloads must never share a target or sidecar with one another.
pub struct DownloadReservation {
    _leases: (
        crate::local_fs::target_reservation::Reservation,
        crate::local_fs::target_reservation::Reservation,
    ),
    keys: [String; 2],
}
impl Drop for DownloadReservation {
    fn drop(&mut self) {
        let mut active = active_downloads().lock().unwrap();
        for key in &self.keys {
            active.remove(key);
        }
    }
}

fn artifact_path(destination: &Path, id: uuid::Uuid) -> PathBuf {
    destination.with_file_name(format!(".ftpeach-{id}.part"))
}

async fn rename_no_replace(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{MOVE_FILE_FLAGS, MoveFileExW},
            core::PCWSTR,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // SAFETY: both buffers are NUL-terminated and live through the call.
        // Omitting REPLACE_EXISTING makes a racing destination an error.
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVE_FILE_FLAGS(0),
            )?;
        }
    }
    #[cfg(not(windows))]
    {
        tokio::fs::hard_link(source, destination).await?;
        tokio::fs::remove_file(source).await?;
    }
    Ok(())
}

/// Open the actual artifact without following a final reparse point. Exclusive
/// Windows sharing prevents its replacement while the transfer owns the handle.
pub fn open_artifact(path: &Path, create_new: bool) -> Result<std::fs::File> {
    crate::local_fs::filesystem_safety::ensure_path_no_reparse_points_now(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(create_new);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000).share_mode(0);
    }
    let file = options.open(path)?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "Transfer artifact is not a regular file"
    );
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle},
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: file owns the live handle and info is valid writable storage.
        unsafe {
            GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info)?;
        }
        anyhow::ensure!(
            info.nNumberOfLinks == 1 && info.dwFileAttributes & 0x400 == 0,
            "Transfer artifact is linked or a reparse point"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            file.metadata()?.nlink() == 1,
            "Transfer artifact has multiple links"
        );
    }
    Ok(file)
}

pub async fn prepare(
    destination: &Path,
    resume: bool,
    source: SourceIdentity,
) -> Result<(PathBuf, u64)> {
    let metadata = sidecar(destination);
    let existing = match open_artifact(&metadata, false) {
        Ok(mut file) => {
            use std::io::Read;
            let mut bytes = Vec::new();
            file.by_ref().take(16 * 1024).read_to_end(&mut bytes)?;
            Some(serde_json::from_slice::<ResumeRecord>(&bytes).context("Invalid resume sidecar; preserve it and choose a new destination or explicitly remove it")?)
        }
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    let has_sidecar = existing.is_some();
    if resume
        && source.version.is_some()
        && source.size.is_some()
        && let Some(record) = existing
        && record.source == source
    {
        let path = artifact_path(destination, record.artifact);
        if let Ok(file) = open_artifact(&path, false) {
            let start = file.metadata()?.len();
            if source.size.is_some_and(|size| start <= size) {
                return Ok((path, start));
            }
        }
    }
    let artifact = uuid::Uuid::new_v4();
    let path = artifact_path(destination, artifact);
    open_artifact(&path, true)?.sync_all()?;
    let record = ResumeRecord { source, artifact };
    let temporary = destination.with_file_name(format!(".ftpeach-{}.json", uuid::Uuid::new_v4()));
    {
        use std::io::Write;
        let mut file = open_artifact(&temporary, true)?;
        file.write_all(&serde_json::to_vec(&record)?)?;
        file.sync_all()?;
    }
    crate::local_fs::filesystem_safety::validate_write_destination(&metadata).await?;
    if has_sidecar {
        tokio::fs::rename(&temporary, &metadata).await?;
    } else {
        rename_no_replace(&temporary, &metadata).await?;
    }
    Ok((path, 0))
}

pub fn validate_resume_offset(start: u64, expected: Option<u64>) -> Result<()> {
    if let Some(size) = expected
        && start > size
    {
        return Err(fail(
            ErrorCode::IntegrityMismatch,
            format!(
                "The local partial file ({start} bytes) is larger than the remote file ({size} bytes)"
            ),
        ));
    }
    Ok(())
}

pub fn validate_length(actual: u64, expected: Option<u64>) -> Result<()> {
    if let Some(expected) = expected
        && actual != expected
    {
        return Err(fail(
            ErrorCode::IntegrityMismatch,
            format!("Expected {expected} bytes, received {actual}"),
        ));
    }
    Ok(())
}

/// Finish a partial that already contains the complete remote file.
///
/// This can happen when cancellation lands after the final write but before
/// the verified partial is renamed. Handling it here keeps FTP, SFTP and
/// WebDAV identical and avoids protocol-specific edge cases such as an HTTP
/// `Range: bytes=<size>-` request being rejected with 416.
pub async fn commit_if_complete(
    partial: &Path,
    destination: &Path,
    start: u64,
    expected: Option<u64>,
) -> Result<bool> {
    if expected != Some(start) || tokio::fs::metadata(partial).await.is_err() {
        return Ok(false);
    }
    commit(partial, destination).await?;
    Ok(true)
}

pub async fn commit(partial: &Path, destination: &Path) -> Result<()> {
    // The partial is a sibling on the same volume. Native rename replaces the
    // destination in one step (MoveFileExW with REPLACE_EXISTING on Windows).
    // Never move or delete the old file first: a failed commit leaves it intact,
    // and interruption before commit leaves the verified partial recoverable.
    open_artifact(partial, false)?
        .sync_all()
        .context("flushing verified download")?;
    if super::overwrite_allowed() {
        tokio::fs::rename(partial, destination)
            .await
            .context("committing verified download")?;
    } else {
        rename_no_replace(partial, destination)
            .await
            .context("committing download without replacement")?;
    }
    // The destination now holds the whole file, so the record kept to resume
    // it is spent; left behind, one would sit beside every downloaded file.
    forget_resume_record(partial, destination).await;
    Ok(())
}

pub async fn remove_empty_new_partial(path: &Path, started_at: u64) {
    if started_at == 0 && tokio::fs::metadata(path).await.is_ok_and(|m| m.len() == 0) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// The resume record kept beside a destination, if one can be read.
fn read_record(metadata: &Path) -> Option<ResumeRecord> {
    use std::io::Read;
    let mut bytes = Vec::new();
    open_artifact(metadata, false)
        .ok()?
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Forgets the record naming `partial` once `partial` has become the
/// destination. A record naming any other artifact is not this download's.
async fn forget_resume_record(partial: &Path, destination: &Path) {
    let metadata = sidecar(destination);
    if read_record(&metadata)
        .is_some_and(|record| artifact_path(destination, record.artifact) == partial)
    {
        let _ = tokio::fs::remove_file(&metadata).await;
    }
}

/// How far into `destination` a download could carry on from: the length of
/// the partial its resume record names, when both are there.
pub fn resumable_len(destination: &Path) -> Option<u64> {
    let record = read_record(&sidecar(destination))?;
    std::fs::symlink_metadata(artifact_path(destination, record.artifact))
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

/// Removes what a download keeps beside `destination` to resume: its sidecar
/// and the partial the sidecar names. For a stopped folder walk taking back
/// what it wrote; the destination itself is never touched, and a sidecar that
/// cannot be read is left alone along with whatever it might point at.
pub async fn discard_resume_artifacts(destination: &Path) {
    let metadata = sidecar(destination);
    let Some(record) = read_record(&metadata) else {
        return;
    };
    let artifact = artifact_path(destination, record.artifact);
    // The same proof every open demands: an unlinked regular file of ours.
    if open_artifact(&artifact, false).is_ok() {
        let _ = tokio::fs::remove_file(&artifact).await;
    }
    let _ = tokio::fs::remove_file(&metadata).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sibling_downloads_in_one_recursive_operation_cannot_share_metadata() {
        crate::local_fs::target_reservation::OWNER
            .scope("same-operation".into(), async {
                let target =
                    std::env::temp_dir().join(format!("same-owner-{}", uuid::Uuid::new_v4()));
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
        let (path, start) = prepare(&destination, true, source.clone()).await.unwrap();
        assert_eq!(start, 0);
        assert_ne!(path, partial_path(&destination));
        std::fs::write(&path, b"half").unwrap();
        assert_eq!(
            prepare(&destination, true, source.clone()).await.unwrap(),
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
            let (complete, _) = prepare(&destination, false, source.clone()).await.unwrap();
            std::fs::write(&complete, b"old-data").unwrap();
            let (fresh, offset) = prepare(&destination, true, changed).await.unwrap();
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
        let (partial, _) = prepare(&destination, false, source.clone()).await.unwrap();
        std::fs::write(&partial, b"keep").unwrap();
        std::fs::hard_link(&partial, root.join("user-file")).unwrap();
        assert!(open_artifact(&partial, false).is_err());
        let (fresh, offset) = prepare(&destination, true, source).await.unwrap();
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
        let (partial, _) = prepare(&destination, false, source.clone()).await.unwrap();
        std::fs::write(&partial, b"complete").unwrap();
        commit(&partial, &destination).await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
        assert!(!sidecar(&destination).exists());
        // A local copy committing its own temporary leaves a download's record be.
        let (downloading, _) = prepare(&destination, false, source).await.unwrap();
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

    #[tokio::test]
    async fn discarding_resume_artifacts_leaves_the_destination_alone() {
        let root = std::env::temp_dir().join(format!("ftpeach-discard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let destination = root.join("file.bin");
        std::fs::write(&destination, b"user").unwrap();
        let source = SourceIdentity {
            endpoint: "server".into(),
            remote_path: "/file".into(),
            size: Some(8),
            version: Some("v1".into()),
        };
        let (partial, _) = prepare(&destination, false, source).await.unwrap();
        std::fs::write(&partial, b"half").unwrap();
        discard_resume_artifacts(&destination).await;
        assert!(!partial.exists());
        assert!(!sidecar(&destination).exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"user");
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
        let root =
            std::env::temp_dir().join(format!("ftpeach-interrupted-{}", uuid::Uuid::new_v4()));
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
        commit(&partial, &destination).await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"verified");
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
            commit(&partial, &destination).await.unwrap();
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
        commit(&partial, &destination).await.unwrap();
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
        assert!(commit(&partial, &destination).await.is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");
        assert_eq!(std::fs::read(&partial).unwrap(), b"verified");
        drop(lock);
        commit(&partial, &destination).await.unwrap();
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
        let root =
            std::env::temp_dir().join(format!("ftpeach-partial-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let destination = root.join("file.bin");
        let partial = partial_path(&destination);
        tokio::fs::write(&destination, b"old").await.unwrap();
        tokio::fs::write(&partial, b"verified").await.unwrap();
        commit(&partial, &destination).await.unwrap();
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"verified");
        assert!(tokio::fs::metadata(&partial).await.is_err());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn complete_partial_is_committed_without_another_transfer() {
        let root =
            std::env::temp_dir().join(format!("ftpeach-complete-test-{}", uuid::Uuid::new_v4()));
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
}
