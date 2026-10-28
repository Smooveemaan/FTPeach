//! Recycle Bin / Trash delete — `fs_delete` (in commands/fs.rs) dispatches
//! here instead of fs_delete.rs's permanent removal. Still runs every target
//! through the same filesystem_safety::validated_delete_target guard as a
//! permanent delete; only the final removal mechanism (SHFileOperationW on
//! Windows, the `trash` crate elsewhere, vs remove_file/remove_dir) differs.
//! Where no bin takes the item, nothing is deleted and `NoRecycleBin` lets
//! the interface offer a permanent delete instead.

use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validated_delete_target,
};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};
#[cfg(windows)]
use windows::Win32::UI::Shell::{SHFILEOPSTRUCTW, SHFileOperationW};
#[cfg(windows)]
use windows::core::PCWSTR;

#[cfg(windows)]
pub(crate) async fn fs_move_to_recycle_bin(local_path: String) -> CommandResult<()> {
    let target = match validated_delete_target(Path::new(&local_path)).await {
        Ok(Some((target, _))) => target,
        Ok(None) => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    let mut source: Vec<u16> = target.as_os_str().encode_wide().collect();
    if source.starts_with(&[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16]) {
        if source.get(4..8) == Some(&[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16]) {
            source.splice(0..8, [b'\\' as u16, b'\\' as u16]);
        } else {
            source.drain(0..4);
        }
    }
    source.extend([0, 0]);
    let result = tokio::task::spawn_blocking(move || {
        ensure_path_no_reparse_points_now(&target)?;
        if !has_recycle_bin(&source) {
            return Err(CommandError::new(
                ErrorCode::NoRecycleBin,
                "This location has no Recycle Bin; nothing was deleted",
            )
            .into());
        }
        let mut operation = SHFILEOPSTRUCTW {
            wFunc: 3, // FO_DELETE
            pFrom: PCWSTR::from_raw(source.as_ptr()),
            fFlags: 0x0040 | 0x0010 | 0x4000, // ALLOWUNDO | NOCONFIRMATION | WANTNUKEWARNING
            ..Default::default()
        };
        // SAFETY: `source` remains alive for the synchronous call and is an
        // absolute, double-NUL-terminated UTF-16 path list as required.
        let code = unsafe { SHFileOperationW(&mut operation) };
        Ok::<(i32, bool), anyhow::Error>((code, operation.fAnyOperationsAborted.as_bool()))
    })
    .await;

    match result {
        Ok(Ok((0, _))) => Ok(()),
        Ok(Ok((_, true))) => Ok(()),
        Ok(Ok((code, false))) => {
            Err(anyhow::anyhow!("Windows file operation failed ({code})").into())
        }
        Ok(Err(error)) => Err(error.into()),
        Err(error) => Err(anyhow::anyhow!("Windows file operation task failed: {error}").into()),
    }
}

#[cfg(not(windows))]
pub(crate) async fn fs_move_to_recycle_bin(local_path: String) -> CommandResult<()> {
    let target = match validated_delete_target(Path::new(&local_path)).await {
        Ok(Some((target, _))) => target,
        Ok(None) => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    let result = tokio::task::spawn_blocking(move || {
        ensure_path_no_reparse_points_now(&target)?;
        let no_bin = || {
            anyhow::Error::from(CommandError::new(
                ErrorCode::NoRecycleBin,
                "This location has no Recycle Bin; nothing was deleted",
            ))
        };
        if !has_trash(&target) {
            return Err(no_bin());
        }
        // The crate never deletes for good: a failure leaves the item where it
        // was. On macOS it goes through Finder, which keeps Put Back.
        #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
        let mut context = trash::TrashContext::default();
        #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
        let mut outcome = context.delete(&target);
        #[cfg(target_os = "macos")]
        if let Err(error) = &outcome {
            // Most often Finder access denied: the bin without Put Back then.
            log::info!(
                "Finder could not move {} to the Trash: {error}",
                target.display()
            );
            trash::macos::TrashContextExtMacos::set_delete_method(
                &mut context,
                trash::macos::DeleteMethod::NsFileManager,
            );
            outcome = context.delete(&target);
        }
        outcome.map_err(|error| {
            log::warn!("could not move {} to the Trash: {error}", target.display());
            no_bin()
        })
    })
    .await;

    match result {
        Ok(result) => Ok(result?),
        Err(error) => Err(anyhow::anyhow!("Trash task failed: {error}").into()),
    }
}

/// Whether the item's own volume has a Trash. Without one the `trash` crate
/// on Linux moves the item to the home Trash, which across volumes copies it
/// whole and deletes the original; that is refused, as with no Trash at all,
/// so the interface warns that a delete would be for good. The per-volume
/// folder is made here, as the crate would make it.
// shortcut: a bind mount of the home volume, or a volume Trash the crate then
// cannot write to, still falls back to that copy; refuse those too if reported.
#[cfg(all(unix, not(target_os = "macos")))]
fn has_trash(target: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let device = |path: &Path| {
        path.ancestors()
            .find_map(|path| std::fs::symlink_metadata(path).ok())
            .map(|metadata| metadata.dev())
    };
    let Some(volume) = device(target) else {
        return false;
    };
    if dirs::data_dir().and_then(|dir| device(&dir.join("Trash"))) == Some(volume) {
        return true;
    }
    let mut top = target;
    while let Some(parent) = top.parent().filter(|parent| device(parent) == Some(volume)) {
        top = parent;
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    match std::fs::create_dir(top.join(format!(".Trash-{uid}"))) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::AlreadyExists,
    }
}

/// Whether the item's volume has a Trash (a share or a disk image may have
/// none); Finder would otherwise offer to delete it for good on its own.
#[cfg(target_os = "macos")]
fn has_trash(target: &Path) -> bool {
    use objc2_foundation::{
        NSFileManager, NSSearchPathDirectory, NSSearchPathDomainMask, NSString, NSURL,
    };
    let Some(path) = target.to_str() else {
        return false;
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSFileManager::defaultManager()
        .URLForDirectory_inDomain_appropriateForURL_create_error(
            NSSearchPathDirectory::TrashDirectory,
            NSSearchPathDomainMask::UserDomainMask,
            Some(&url),
            true,
        )
        .is_ok()
}

/// Asks at startup, once (macOS remembers the answer), for the right to have
/// Finder delete items, so a trashed item keeps Finder's Put Back. Denied,
/// "To the Trash" still works, without Put Back. Runs on its own thread: the
/// call waits for the answer to the system prompt.
#[cfg(target_os = "macos")]
pub(crate) fn ask_for_finder_access() {
    use std::ffi::c_void;
    #[repr(C)]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn AECreateDesc(
            type_code: u32,
            data: *const c_void,
            size: isize,
            result: *mut AEDesc,
        ) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            event_class: u32,
            event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
    }
    const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
    const CORE_SUITE: u32 = u32::from_be_bytes(*b"core");
    const DELETE: u32 = u32::from_be_bytes(*b"delo");

    std::thread::spawn(|| {
        let finder = b"com.apple.finder";
        let mut target = AEDesc {
            descriptor_type: 0,
            data_handle: std::ptr::null_mut(),
        };
        // SAFETY: `finder` outlives AECreateDesc, which copies it into
        // `target`; `target` is disposed of once, after its last use.
        let status = unsafe {
            if AECreateDesc(
                TYPE_APPLICATION_BUNDLE_ID,
                finder.as_ptr().cast(),
                finder.len() as isize,
                &mut target,
            ) != 0
            {
                return;
            }
            let status = AEDeterminePermissionToAutomateTarget(&target, CORE_SUITE, DELETE, 1);
            AEDisposeDesc(&mut target);
            status
        };
        if status != 0 {
            log::info!("Finder access for the Trash not granted ({status})");
        }
    });
}

/// Windows keeps a Recycle Bin on fixed drives only. On a share or a removable
/// drive the shell deletes for good, and with no confirmation asked for, it
/// does so without a word, so such a delete is refused instead. `path` is
/// NUL-terminated.
#[cfg(windows)]
fn has_recycle_bin(path: &[u16]) -> bool {
    const DRIVE_FIXED: u32 = 3;
    let mut root = [0u16; 1024];
    // SAFETY: `path` is NUL-terminated and `root` is a writable buffer of
    // the length passed; GetDriveTypeW reads the NUL-terminated root it got.
    unsafe {
        GetVolumePathNameW(PCWSTR::from_raw(path.as_ptr()), &mut root).is_ok()
            && GetDriveTypeW(PCWSTR::from_raw(root.as_ptr())) == DRIVE_FIXED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[tokio::test]
    async fn a_temp_file_goes_to_the_trash() {
        let file = std::env::temp_dir().join(format!("ftpeach-trash-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"test").unwrap();

        let result = fs_move_to_recycle_bin(file.to_string_lossy().into_owned()).await;

        assert!(result.is_ok(), "{result:?}");
        assert!(!file.exists());
    }

    // /proc is a volume of its own where no Trash folder can be made, so the
    // crate would copy the item to the home Trash.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn a_volume_whose_trash_cannot_be_made_has_none() {
        assert!(!has_trash(Path::new("/proc/self/status")));
    }

    #[cfg(windows)]
    fn wide(path: &str) -> Vec<u16> {
        path.encode_utf16().chain([0]).collect()
    }

    // A share is the file-system stand's; here only that a fixed drive
    // keeps its Recycle Bin and a path with no volume has none.
    #[cfg(windows)]
    #[test]
    fn a_fixed_drive_has_a_recycle_bin() {
        let temp = std::env::temp_dir();
        assert!(has_recycle_bin(&wide(&temp.to_string_lossy())));
        assert!(!has_recycle_bin(&wide(
            r"\\no-such-host.invalid\share\file"
        )));
    }
}
