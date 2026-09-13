//! Cross-volume file Move. Both objects stay protected through verification
//! and source disposition; destination publication renames the open handle.
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::*};

pub(crate) fn is_cross_volume(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        e.downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(17))
            || e.downcast_ref::<windows::core::Error>()
                .is_some_and(|e| e.code().0 as u32 == 0x80070011)
    })
}

fn disposition(file: &File) -> Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: a live DELETE-capable handle and a correctly sized input buffer.
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of_val(&info) as u32,
        )?;
    }
    Ok(())
}

fn publish(file: &File, destination: &Path, overwrite: bool) -> Result<()> {
    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    let length = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + (name.len() + 1) * 2;
    let mut storage = vec![0u64; length.div_ceil(8)];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: u64 storage supplies alignment and enough space for the header
    // and variable UTF-16 name. The zeroed trailing word terminates the name.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = overwrite;
        (*info).FileNameLength = u32::try_from(name.len() * 2)?;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileRenameInfo,
            info.cast(),
            u32::try_from(length)?,
        )?;
    }
    Ok(())
}

fn hash(file: &mut File) -> Result<(u64, [u8; 32])> {
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut count = 0;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        digest.update(&buffer[..n]);
    }
    Ok((count, digest.finalize().into()))
}

pub(crate) fn copy_verify_delete(source: &Path, destination: &Path, overwrite: bool) -> Result<()> {
    copy_with_hook(source, destination, overwrite, |_, _| Ok(()))
}

fn copy_with_hook(
    source: &Path,
    destination: &Path,
    overwrite: bool,
    before_verify: impl FnOnce(&File, &mut File) -> Result<()>,
) -> Result<()> {
    use super::filesystem_safety::ensure_path_no_reparse_points_now;
    ensure_path_no_reparse_points_now(source)?;
    ensure_path_no_reparse_points_now(destination)?;
    // READ + DELETE; deny external writes, rename and deletion for the entire operation.
    let mut input = OpenOptions::new()
        .read(true)
        .access_mode(0x80010000)
        .share_mode(1)
        .custom_flags(0x00200000)
        .open(source)?;
    let metadata = input.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "Verified cross-volume Move requires a regular file"
    );
    let parent = destination.parent().context("Destination has no parent")?;
    let stage = parent.join(format!(".ftpeach-move-{}.part", uuid::Uuid::new_v4()));
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(0xc0010000)
        .share_mode(1)
        .custom_flags(0x00200000)
        .open(&stage)?;
    let mut published = false;
    let operation = (|| -> Result<()> {
        let mut digest = Sha256::new();
        let mut count = 0;
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            output.write_all(&buffer[..n])?;
            count += n as u64;
            digest.update(&buffer[..n]);
        }
        anyhow::ensure!(count == metadata.len(), "Source changed during Move");
        let copied: (u64, [u8; 32]) = (count, digest.finalize().into());
        output.sync_all()?;
        before_verify(&input, &mut output)?;
        anyhow::ensure!(
            hash(&mut output)? == copied,
            "Destination verification failed; source retained"
        );
        anyhow::ensure!(
            hash(&mut input)? == copied,
            "Source changed; source retained"
        );
        if let Ok(modified) = metadata.modified() {
            output.set_modified(modified)?;
        }
        output.sync_all()?;
        ensure_path_no_reparse_points_now(destination)?;
        publish(&output, destination, overwrite)?;
        published = true;
        // The published destination is still the same open, protected object.
        disposition(&input).context("Verified copy retained, but source deletion failed")?;
        Ok(())
    })();
    if let Err(error) = operation {
        if !published {
            if let Err(cleanup) = disposition(&output) {
                return Err(error.context(format!(
                    "Source retained; temporary file retained at {}: {cleanup}",
                    stage.display()
                )));
            }
        } else {
            return Err(error.context(format!(
                "Verified destination retained at {}",
                destination.display()
            )));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("ftpeach-verified-move-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        (root.clone(), root.join("source"), root.join("target"))
    }
    fn cleanup(root: &Path) {
        for entry in std::fs::read_dir(root).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn verified_move_handles_large_and_empty_files() {
        for size in [0, 3 * 1024 * 1024 + 7] {
            let (root, source, target) = fixture();
            let bytes = vec![42; size];
            std::fs::write(&source, &bytes).unwrap();
            copy_with_hook(&source, &target, false, |_, _| {
                assert!(OpenOptions::new().write(true).open(&source).is_err());
                assert!(std::fs::remove_file(&source).is_err());
                Ok(())
            })
            .unwrap();
            assert!(!source.exists());
            assert_eq!(std::fs::read(&target).unwrap(), bytes);
            cleanup(&root);
        }
    }
    #[test]
    fn corrupt_copy_preserves_source_and_existing_target() {
        let (root, source, target) = fixture();
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&target, b"external").unwrap();
        assert!(
            copy_with_hook(&source, &target, true, |_, file| {
                file.seek(SeekFrom::Start(0))?;
                file.write_all(b"broken")?;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&target).unwrap(), b"external");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        cleanup(&root);
    }
    #[test]
    fn fallback_only_accepts_cross_volume_errors() {
        assert!(is_cross_volume(
            &std::io::Error::from_raw_os_error(17).into()
        ));
        assert!(is_cross_volume(
            &windows::core::Error::from(windows::core::HRESULT(0x80070011u32 as i32)).into()
        ));
        for code in [5, 32, 80, 112, 183] {
            assert!(!is_cross_volume(
                &std::io::Error::from_raw_os_error(code).into()
            ));
        }
    }
    #[test]
    fn collision_requires_explicit_overwrite() {
        let (root, source, target) = fixture();
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&target, b"external").unwrap();
        assert!(copy_verify_delete(&source, &target, false).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&target).unwrap(), b"external");
        copy_verify_delete(&source, &target, true).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"source");
        cleanup(&root);
    }
}
