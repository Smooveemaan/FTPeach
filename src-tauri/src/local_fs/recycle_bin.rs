//! Windows recycle-bin delete — `fs_delete` (in commands/fs.rs) dispatches
//! here instead of fs_delete.rs's permanent removal whenever the platform
//! supports it. Still runs every target through the same
//! filesystem_safety::validated_delete_target guard as a permanent delete;
//! only the final removal mechanism (SHFileOperationW vs remove_file/
//! remove_dir) differs.

use crate::ipc::{OkResult, err, ok};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validated_delete_target,
};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::Win32::UI::Shell::{SHFILEOPSTRUCTW, SHFileOperationW};
use windows::core::PCWSTR;

pub(crate) async fn fs_move_to_recycle_bin(local_path: String) -> OkResult {
    let target = match validated_delete_target(Path::new(&local_path)).await {
        Ok(Some((target, _))) => target,
        Ok(None) => return ok(),
        Err(error) => return err(error),
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
        Ok(Ok((0, _))) => ok(),
        Ok(Ok((_, true))) => ok(),
        Ok(Ok((code, false))) => err(anyhow::anyhow!("Windows file operation failed ({code})")),
        Ok(Err(error)) => err(error),
        Err(error) => err(anyhow::anyhow!(
            "Windows file operation task failed: {error}"
        )),
    }
}
