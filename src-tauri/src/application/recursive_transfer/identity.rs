//! Local object receipts. Windows deletion uses the verified handle, with
//! write/delete sharing denied until disposition has been set.
use anyhow::{Context, Result};
use std::{fs::File, path::Path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Receipt {
    identity: (u64, u64),
    version: (i128, i128),
    revision: Option<Revision>,
    pub size: u64,
    pub directory: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Revision {
    #[cfg(windows)]
    Usn(i64),
    Digest([u8; 32]),
}

impl Receipt {
    pub(super) fn verified(&self) -> bool {
        self.directory || self.revision.is_some()
    }
}

// Hash only small files when the filesystem has no change journal. Large
// unversioned files remain copyable, but never authorize Resume skips/deletes.
const HASH_LIMIT: u64 = 1024 * 1024;
fn revision(file: &File, size: u64) -> Result<Option<Revision>> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::IO::DeviceIoControl};
        let mut buffer = [0u8; 1024];
        let mut returned = 0;
        // SAFETY: file owns the handle; the output buffer and byte count are
        // valid for this synchronous FSCTL_READ_FILE_USN_DATA call (METHOD_NEITHER).
        let result = unsafe {
            DeviceIoControl(
                HANDLE(file.as_raw_handle()),
                0x0009_00eb,
                None,
                0,
                Some(buffer.as_mut_ptr().cast()),
                buffer.len() as u32,
                Some(&mut returned),
                None,
            )
        };
        if result.is_ok() && returned >= 8 {
            let offset = match u16::from_le_bytes([buffer[4], buffer[5]]) {
                2 => Some(24),
                3 => Some(40),
                _ => None,
            };
            if let Some(offset) = offset
                && returned as usize >= offset + 8
            {
                let usn = i64::from_le_bytes(buffer[offset..offset + 8].try_into()?);
                if usn > 0 {
                    return Ok(Some(Revision::Usn(usn)));
                }
            }
        }
    }
    if size > HASH_LIMIT {
        return Ok(None);
    }
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom};
    let mut reader = file.try_clone()?;
    reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        anyhow::ensure!(total <= size, "File changed while recording its version");
        hash.update(&buffer[..read]);
    }
    anyhow::ensure!(total == size, "File changed while recording its version");
    Ok(Some(Revision::Digest(hash.finalize().into())))
}

pub(super) fn open(path: &Path, deleting: bool, exclusive: bool) -> Result<File> {
    crate::local_fs::filesystem_safety::ensure_path_no_reparse_points_now(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // GENERIC_READ, DELETE, FILE_SHARE_READ, BACKUP_SEMANTICS,
        // OPEN_REPARSE_POINT. Metadata access also works for directories.
        options
            .access_mode(0x8000_0000 | if deleting { 0x10000 } else { 0 })
            .share_mode(if exclusive { 1 } else { 7 })
            .custom_flags(0x0200_0000 | 0x0020_0000);
    }
    #[cfg(not(windows))]
    anyhow::ensure!(
        !deleting && !exclusive,
        "Exclusive verified deletion is unavailable; source retained"
    );
    options
        .open(path)
        .with_context(|| format!("Cannot protect {} from external changes", path.display()))
}

pub(super) fn receipt(file: &File) -> Result<Receipt> {
    let metadata = file.metadata()?;
    anyhow::ensure!(
        !metadata.file_type().is_symlink(),
        "Object was replaced by a link"
    );
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::*};
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        let mut basic = FILE_BASIC_INFO::default();
        // SAFETY: file owns a live handle; both output buffers have the exact
        // API structure size and remain valid throughout the calls.
        unsafe {
            GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info)?;
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of_val(&basic) as u32,
            )?;
        }
        anyhow::ensure!(
            info.dwFileAttributes & 0x400 == 0,
            "Object is a reparse point"
        );
        Ok(Receipt {
            identity: (
                info.dwVolumeSerialNumber as u64,
                ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            ),
            version: (basic.ChangeTime as i128, basic.LastWriteTime as i128),
            revision: if metadata.is_file() {
                revision(file, metadata.len())?
            } else {
                None
            },
            size: metadata.len(),
            directory: metadata.is_dir(),
        })
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Receipt {
            identity: (metadata.dev(), metadata.ino()),
            version: (
                metadata.ctime() as i128 * 1_000_000_000 + metadata.ctime_nsec() as i128,
                metadata.mtime() as i128 * 1_000_000_000 + metadata.mtime_nsec() as i128,
            ),
            revision: if metadata.is_file() {
                revision(file, metadata.len())?
            } else {
                None
            },
            size: metadata.len(),
            directory: metadata.is_dir(),
        })
    }
    #[cfg(not(any(windows, unix)))]
    anyhow::bail!("Object identity unavailable")
}

pub(super) fn capture(path: &Path) -> Result<Receipt> {
    receipt(&open(path, false, false)?)
}

pub(super) fn protect(path: &Path, expected: &Receipt, deleting: bool) -> Result<File> {
    anyhow::ensure!(
        expected.verified(),
        "Strong file version unavailable; object retained: {}",
        path.display()
    );
    let file = open(path, deleting, true)?;
    let actual = receipt(&file)?;
    // Child creation/removal changes directory timestamps, but never permits
    // deleting a replacement directory or its contents.
    anyhow::ensure!(
        if expected.directory {
            actual.directory && expected.identity == actual.identity
        } else {
            expected == &actual
        },
        "Object changed; retained: {}",
        path.display()
    );
    Ok(file)
}

pub(super) fn delete(file: &File) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::*};
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: file retains the verified handle and the correctly sized
        // input structure is alive throughout this synchronous call.
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of_val(&disposition) as u32,
            )?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        anyhow::bail!("Verified deletion unavailable; object retained")
    }
}
