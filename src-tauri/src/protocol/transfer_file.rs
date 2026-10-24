//! Shared local-file policy for downloads.

use crate::ipc::ErrorCode;
use crate::protocol::fail;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[cfg(test)]
pub const PARTIAL_SUFFIX: &str = ".ftpeach-part";

#[cfg(test)]
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

/// Diagnostic paths only: a sidecar is not proof of current object ownership.
pub(crate) fn retained_paths(destination: &Path) -> Vec<PathBuf> {
    let metadata = sidecar(destination);
    match read_record(&metadata) {
        Some(record) => vec![artifact_path(destination, record.artifact), metadata],
        None => Vec::new(),
    }
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

/// Whether `name` is a working file a transfer keeps beside its destination:
/// a partial `.ftpeach-<uuid>.part` (a download's, a copy's, or an upload's
/// staging on a server), a download's `<name>.ftpeach-resume.json`, and that
/// record's `.ftpeach-<uuid>.json` while it is written.
pub(crate) fn is_artifact_name(name: &str) -> bool {
    let staged = |suffix| {
        name.strip_prefix(".ftpeach-")
            .and_then(|rest| rest.strip_suffix(suffix))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    };
    staged(".part") || staged(".json") || name.ends_with(".ftpeach-resume.json")
}

fn artifact_path(destination: &Path, id: uuid::Uuid) -> PathBuf {
    destination.with_file_name(format!(".ftpeach-{id}.part"))
}

pub(crate) async fn rename_no_replace(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use crate::local_fs::long_path;
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{MOVE_FILE_FLAGS, MoveFileExW},
            core::PCWSTR,
        };
        let source: Vec<u16> = long_path(source)?
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let destination: Vec<u16> = long_path(destination)?
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
            )
        }
        // The HRESULT wraps the system error code in its low word. As an
        // `io::Error` it keeps its kind, so a taken name or a file in use is
        // reported as that instead of as an unexpected failure.
        .map_err(|error| std::io::Error::from_raw_os_error(error.code().0 & 0xFFFF))?;
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
    origin: crate::local_fs::provenance::Origin,
) -> Result<(PathBuf, u64)> {
    let metadata = sidecar(destination);
    let existing = match while_busy(|| async { open_artifact(&metadata, false) }).await {
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
        // Held by another program, the partial is not given up for a new
        // one: the record would then name the new one, and nothing would
        // ever remove the old.
        let opened = while_busy(|| async { open_artifact(&path, false) }).await;
        if let Err(error) = &opened
            && busy(error)
        {
            return Err(opened.unwrap_err());
        }
        if let Ok(file) = opened {
            let start = file.metadata()?.len();
            if source.size.is_some_and(|size| start <= size) {
                // A resumed artifact already carries the mark, but one
                // written by a version that did not is caught up here
                // rather than committed without it.
                crate::local_fs::provenance::mark(&path, &origin);
                return Ok((path, start));
            }
        }
    }
    let artifact = uuid::Uuid::new_v4();
    let path = artifact_path(destination, artifact);
    open_artifact(&path, true)?.sync_all()?;
    // Marked on the artifact, not on the finished file: committing is a
    // rename on the same volume, which carries the stream with it, so the
    // mark cannot be lost between the last byte and the final name.
    crate::local_fs::provenance::mark(&path, &origin);
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

/// A download's hold on its local destination, from before the server is
/// asked anything until the file is committed: the destination and resume
/// record stay reserved for as long as this lives, which keeps local moves
/// and deletes of them or their folders out. Local mutations elsewhere are
/// kept out only while a step works by path (preparing, reopening and
/// committing the artifact); the bytes go through a handle. Held for the
/// whole transfer, a slow download stopped every move, delete and new folder
/// on the computer until it ended. Every backend's `download` goes through
/// it, so their local side cannot drift apart:
///
/// 1. [`DownloadTarget::reserve`] before reading remote metadata;
/// 2. [`DownloadTarget::prepare`] with the backend's own [`SourceIdentity`]
///    (FTP MDTM, SFTP attributes, WebDAV ETag; `None` when the server gives
///    none, never a made-up value);
/// 3. the backend's transport writes through [`LocalDownload::open_at`];
/// 4. [`LocalDownload::finish`] checks the length and commits;
/// 5. [`report_outcome`] sends the one terminal progress event.
pub struct DownloadTarget {
    destination: PathBuf,
    _lease: DownloadReservation,
}

impl DownloadTarget {
    pub async fn reserve(destination: &Path) -> Result<Self> {
        let lease = reserve(destination)?;
        let _mutation = crate::local_fs::mutations::guard().read().await;
        crate::local_fs::mutations::validate_download_name(destination)?;
        crate::local_fs::filesystem_safety::validate_write_destination(destination).await?;
        Ok(Self {
            destination: destination.to_path_buf(),
            _lease: lease,
        })
    }

    /// Picks the artifact to write: the matching partial to resume, or a new
    /// one. `None` means a partial already held the whole file and has been
    /// committed, with nothing left to transfer.
    pub async fn prepare(
        self,
        resume: bool,
        source: SourceIdentity,
        origin: crate::local_fs::provenance::Origin,
    ) -> Result<Option<LocalDownload>> {
        let expected = source.size;
        let _mutation = crate::local_fs::mutations::guard().read().await;
        let (partial, start) = prepare(&self.destination, resume, source, origin).await?;
        validate_resume_offset(start, expected)?;
        if commit_if_complete(&partial, &self.destination, start, expected).await? {
            return Ok(None);
        }
        Ok(Some(LocalDownload {
            target: self,
            partial,
            start,
        }))
    }
}

/// The artifact a download writes, still held by its [`DownloadTarget`].
pub struct LocalDownload {
    target: DownloadTarget,
    partial: PathBuf,
    start: u64,
}

impl LocalDownload {
    /// Bytes already in the artifact, where the transfer resumes.
    pub fn start(&self) -> u64 {
        self.start
    }

    /// The artifact opened for writing at `offset`: the resume point, or 0
    /// when the server sends the whole file again, which drops what was there.
    pub async fn open_at(&self, offset: u64) -> Result<tokio::fs::File> {
        use tokio::io::AsyncSeekExt;
        let file = while_busy(|| async {
            let _mutation = crate::local_fs::mutations::guard().read().await;
            open_artifact(&self.partial, false)
        })
        .await?;
        let mut file = tokio::fs::File::from_std(file);
        if offset == 0 {
            file.set_len(0).await?;
        } else {
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .context("seeking local file")?;
        }
        Ok(file)
    }

    /// Ends the local side of the transfer. `written` is the transport's
    /// outcome: the total length of the artifact, flushed. On success the
    /// length is checked against `expected` and the artifact committed; on
    /// any failure, commit included, a partial this attempt created empty is
    /// removed and a resumable one is kept.
    pub async fn finish(self, written: Result<u64>, expected: Option<u64>) -> Result<()> {
        let _mutation = crate::local_fs::mutations::guard().read().await;
        let result = match written {
            Ok(length) => match validate_length(length, expected) {
                Ok(()) => commit(&self.partial, &self.target.destination).await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        if let Err(error) = &result {
            // Bytes of two versions: nothing to resume from.
            if crate::ipc::CommandError::from_anyhow(error).code == ErrorCode::RemoteChanged
                && let Err(error) = remove_artifact(&self.partial)
            {
                log::warn!("A download of a changed file left its partial: {error:#}");
            }
            remove_empty_new_partial(&self.partial, self.start).await;
            // Gone, the partial has nothing to resume; its record would only
            // be litter beside the destination.
            if tokio::fs::symlink_metadata(&self.partial).await.is_err() {
                forget_resume_record(&self.partial, &self.target.destination).await;
            }
        }
        result
    }
}

/// The terminal progress event for a finished download, whatever step it
/// ended at, so the queue row always agrees with the returned result.
pub fn report_outcome(result: &Result<()>, progress: &super::ProgressSink) {
    match result {
        Ok(()) => progress(super::ProgressInfo::Done),
        Err(error) => progress(super::ProgressInfo::failed(error)),
    }
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

/// The transport's outcome, or a `RemoteChanged` failure when the file on the
/// server is no longer the one `before` described. Only a whole read and a
/// read of the wrong length can hide a change, so only they ask the server
/// again. A change is reported only from what the server answered both
/// times: an answer missing the second time keeps the outcome as it is.
pub async fn unless_changed<F: Future<Output = SourceIdentity>>(
    written: Result<u64>,
    before: &SourceIdentity,
    after: impl FnOnce() -> F,
) -> Result<u64> {
    let may_have_changed = match &written {
        Ok(_) => true,
        Err(error) => {
            crate::ipc::CommandError::from_anyhow(error).code == ErrorCode::IntegrityMismatch
        }
    };
    if !may_have_changed || before.size.is_none() && before.version.is_none() {
        return written;
    }
    let after = after().await;
    let versions = before.version.as_ref().zip(after.version.as_ref());
    let sizes = before.size.zip(after.size);
    if versions.is_some_and(|(before, after)| before != after)
        || sizes.is_some_and(|(before, after)| before != after)
    {
        return Err(fail(
            ErrorCode::RemoteChanged,
            "The file on the server changed while it was downloading",
        ));
    }
    if written.is_ok() && versions.is_none() {
        let why = if sizes.is_some() {
            "the server gives no version, so only the size shows it did not change during the download"
        } else {
            "the server did not answer after the download, so it is not known whether the file changed meanwhile"
        };
        log::warn!("{}: {why}", before.remote_path);
    }
    written
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
    // A virus scanner or a search indexer reading the partial holds it
    // only for a moment; waiting it out saves the download. A destination
    // held by another program fails access denied, so it is not waited for.
    while_busy(|| async { Ok(open_artifact(partial, false)?.sync_all()?) })
        .await
        .context("flushing verified download")?;
    if super::overwrite_allowed() {
        while_busy(|| async { Ok(tokio::fs::rename(partial, destination).await?) })
            .await
            .map_err(|error| match error.downcast::<std::io::Error>() {
                Ok(error) => held_by_another_program(error, destination).into(),
                Err(error) => error,
            })
            .context("committing verified download")?;
    } else {
        while_busy(|| rename_no_replace(partial, destination))
            .await
            .context("committing download without replacement")?;
    }
    // The destination now holds the whole file, so the record kept to resume
    // it is spent; left behind, one would sit beside every downloaded file.
    forget_resume_record(partial, destination).await;
    Ok(())
}

/// Windows refuses to replace a file another program holds without sharing
/// delete (as Word does) with access denied, not a sharing violation, which
/// would send the user looking at permissions instead of closing the file.
/// Opening the file for delete tells the two apart.
fn held_by_another_program(error: std::io::Error, destination: &Path) -> std::io::Error {
    #[cfg(windows)]
    if error.raw_os_error() == Some(5) {
        use std::os::windows::fs::OpenOptionsExt;
        const DELETE: u32 = 0x0001_0000;
        // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        let probe = std::fs::OpenOptions::new()
            .access_mode(DELETE)
            .share_mode(7)
            .open(destination);
        if let Err(busy) = probe
            && busy.raw_os_error() == Some(32)
        {
            return busy;
        }
    }
    #[cfg(not(windows))]
    let _ = destination;
    error
}

pub async fn remove_empty_new_partial(path: &Path, started_at: u64) {
    if started_at == 0 && tokio::fs::metadata(path).await.is_ok_and(|m| m.len() == 0) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// The resume record kept beside a destination, if one can be read.
fn read_record(metadata: &Path) -> Option<ResumeRecord> {
    load_record(metadata).ok().flatten()
}

/// The resume record, `None` when there is none or it is not one; an error
/// when it cannot be read, as while another program holds it.
fn load_record(metadata: &Path) -> Result<Option<ResumeRecord>> {
    use std::io::Read;
    let file = match open_artifact(metadata, false) {
        Ok(file) => file,
        Err(error) if not_found(&error) => return Ok(None),
        Err(error) => return Err(error.context("reading the resume record")),
    };
    let mut bytes = Vec::new();
    file.take(16 * 1024)
        .read_to_end(&mut bytes)
        .context("reading the resume record")?;
    Ok(serde_json::from_slice(&bytes).ok())
}

fn io_errors(error: &anyhow::Error) -> impl Iterator<Item = &std::io::Error> {
    error.chain().filter_map(|cause| cause.downcast_ref())
}

fn not_found(error: &anyhow::Error) -> bool {
    io_errors(error).any(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// How many times, half a second apart, a step is tried while another
/// program (a virus scanner, a search indexer, a preview) holds its file.
const BUSY_TRIES: u32 = 10;

/// Whether `error` is a file another program holds open:
/// ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION, which only Windows has.
fn busy(error: &anyhow::Error) -> bool {
    cfg!(windows) && io_errors(error).any(|error| matches!(error.raw_os_error(), Some(32 | 33)))
}

/// Runs `step` again while it fails on a file another program holds open.
async fn while_busy<T, F: Future<Output = Result<T>>>(mut step: impl FnMut() -> F) -> Result<T> {
    let mut tries = 1;
    loop {
        match step().await {
            Err(error) if tries < BUSY_TRIES && busy(&error) => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            result => return result,
        }
    }
}

/// Removes `path` unless it is already gone or behind a link.
fn remove_artifact(path: &Path) -> Result<()> {
    crate::local_fs::filesystem_safety::ensure_path_no_reparse_points_now(path)?;
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(error).with_context(|| format!("removing {}", path.display()))
        }
        _ => Ok(()),
    }
}

/// Forgets the record naming `partial` once `partial` has become the
/// destination. A record naming any other artifact is not this download's.
async fn forget_resume_record(partial: &Path, destination: &Path) {
    let metadata = &sidecar(destination);
    let forgotten = while_busy(|| async {
        match load_record(metadata)? {
            Some(record) if artifact_path(destination, record.artifact) == partial => {
                remove_artifact(metadata)
            }
            _ => Ok(()),
        }
    })
    .await;
    if let Err(error) = forgotten {
        log::warn!("A spent resume record was left beside the download: {error:#}");
    }
}

/// Removes what a stopped download kept beside `destination`: the partial its
/// resume record names, then the record. Left alone if another download is
/// using the destination now.
pub async fn discard(destination: &Path) {
    let Ok(_lease) = reserve(destination) else {
        return;
    };
    let _mutation = crate::local_fs::mutations::guard().read().await;
    let metadata = &sidecar(destination);
    let discarded = while_busy(|| async {
        let Some(record) = load_record(metadata)? else {
            return Ok(());
        };
        // The record is what finds the partial again, so it goes only after
        // the partial; a retry after either step starts from the record.
        remove_artifact(&artifact_path(destination, record.artifact))?;
        remove_artifact(metadata)
    })
    .await;
    if let Err(error) = discarded {
        log::warn!("A stopped download left files beside its destination: {error:#}");
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

#[cfg(test)]
#[path = "transfer_file_tests.rs"]
mod tests;
