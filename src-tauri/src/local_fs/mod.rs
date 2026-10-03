pub(crate) mod edit_recovery;
pub(crate) mod filesystem_safety;
pub(crate) mod fs_delete;
pub(crate) mod fs_listing;
pub(crate) mod local_create;
pub(crate) mod local_open;
pub(crate) mod mutations;
pub(crate) mod open_with;
pub(crate) mod portable;
pub(crate) mod preview;
pub(crate) mod provenance;
#[cfg(windows)]
pub(crate) mod recycle_bin;
pub(crate) mod staged_copy;

pub(crate) mod target_reservation;

#[cfg(windows)]
pub(crate) mod verified_move;
pub(crate) mod windows_names;

/// `path` as a Windows API call that takes a raw name needs it: absolute, with
/// backslashes, and with the `\\?\` prefix that lifts the 260-character limit.
/// std adds that prefix for its own calls; a direct call has to add it itself.
#[cfg(windows)]
pub(crate) fn long_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let absolute: Vec<u16> = std::path::absolute(path)?
        .as_os_str()
        .encode_wide()
        .collect();
    let starts = |prefix: &str| absolute.starts_with(&prefix.encode_utf16().collect::<Vec<_>>());
    let (prefix, rest) = if starts(r"\\?\") || starts(r"\\.\") {
        ("", &absolute[..])
    } else if starts(r"\\") {
        // `\\server\share` becomes `\\?\UNC\server\share`.
        (r"\\?\UNC", &absolute[1..])
    } else {
        (r"\\?\", &absolute[..])
    };
    let wide: Vec<u16> = prefix.encode_utf16().chain(rest.iter().copied()).collect();
    Ok(std::ffi::OsString::from_wide(&wide).into())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn long_path_prefixes_drive_and_share_paths_once() {
        let long = |path: &str| super::long_path(path.as_ref()).unwrap();
        assert_eq!(long(r"C:\a/b\..\c"), std::path::Path::new(r"\\?\C:\a\c"));
        assert_eq!(
            long(r"\\server\share\a/b"),
            std::path::Path::new(r"\\?\UNC\server\share\a\b")
        );
        assert_eq!(long(r"\\?\C:\a"), std::path::Path::new(r"\\?\C:\a"));
    }
}
