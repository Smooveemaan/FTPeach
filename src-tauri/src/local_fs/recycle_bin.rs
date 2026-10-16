//! Windows recycle-bin delete — `fs_delete` (in commands/fs.rs) dispatches
//! here instead of fs_delete.rs's permanent removal whenever the platform
//! supports it. Still runs every target through the same
//! filesystem_safety::validated_delete_target guard as a permanent delete;
//! only the final removal mechanism (SHFileOperationW vs remove_file/
//! remove_dir) differs.

use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validated_delete_target,
};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};
use windows::Win32::UI::Shell::{SHFILEOPSTRUCTW, SHFileOperationW};
use windows::core::PCWSTR;

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

/// Windows keeps a Recycle Bin on fixed drives only. On a share or a removable
/// drive the shell deletes for good, and with no confirmation asked for, it
/// does so without a word, so such a delete is refused instead. `path` is
/// NUL-terminated.
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

    fn wide(path: &str) -> Vec<u16> {
        path.encode_utf16().chain([0]).collect()
    }

    // A share is the file-system stand's; here only that a fixed drive
    // keeps its Recycle Bin and a path with no volume has none.
    #[test]
    fn a_fixed_drive_has_a_recycle_bin() {
        let temp = std::env::temp_dir();
        assert!(has_recycle_bin(&wide(&temp.to_string_lossy())));
        assert!(!has_recycle_bin(&wide(
            r"\\no-such-host.invalid\share\file"
        )));
    }
}
