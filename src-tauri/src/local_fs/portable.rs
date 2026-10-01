//! Portable mode: everything FTPeach stores lives in `data\` beside the
//! program instead of in the Windows profile. An `FTPeach.portable` file next
//! to the exe is the whole switch, and there is no fallback from one location
//! to the other: a copy with the marker never reads or writes the profile's
//! data, and a copy without it never looks beside the exe.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const MARKER: &str = "FTPeach.portable";

/// `dir` when it holds the marker.
pub fn root_for(dir: &Path) -> Option<PathBuf> {
    dir.join(MARKER).exists().then(|| dir.to_path_buf())
}

/// The program's folder when this copy is portable.
pub fn root() -> Option<&'static Path> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| root_for(std::env::current_exe().ok()?.parent()?))
        .as_deref()
}

/// What `%APPDATA%\FTPeach` holds in an installed copy.
pub fn data_dir(root: &Path) -> PathBuf {
    root.join("data")
}

/// What `%LOCALAPPDATA%\com.smooveemaan.ftpeach` holds in an installed copy,
/// the WebView2 profile aside.
pub fn local_dir(root: &Path) -> PathBuf {
    data_dir(root).join("local")
}

pub fn webview_dir(root: &Path) -> PathBuf {
    data_dir(root).join("webview")
}

/// Creates `data\` and proves a file can be written there, so a read-only
/// folder is reported at start instead of as lost settings later.
pub fn prepare(data: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data)?;
    let probe = data.join(format!(".write-test-{}", std::process::id()));
    std::fs::write(&probe, b"")?;
    std::fs::remove_file(probe)
}

/// How a bookmark keeps a key or certificate file: one inside the portable
/// copy's folder is kept relative to it, so it is found again when the folder
/// moves or its drive gets another letter. Any other path is kept as given.
pub fn stored_path(path: &str, root: Option<&Path>) -> String {
    let relative = root.and_then(|root| {
        let mut rest = Path::new(path).components();
        // ponytail: ASCII case folding only; a folder name that differs in the
        // case of other letters keeps the absolute path, which still works here.
        let inside = root.components().all(|expected| {
            rest.next().is_some_and(|actual| {
                actual
                    .as_os_str()
                    .eq_ignore_ascii_case(expected.as_os_str())
            })
        });
        let rest = rest.as_path();
        (inside && !rest.as_os_str().is_empty()).then(|| rest.to_string_lossy().into_owned())
    });
    relative.unwrap_or_else(|| path.to_owned())
}

/// The file a path kept by [`stored_path`] names in this copy.
pub fn resolved_path(path: &str, root: Option<&Path>) -> String {
    match root {
        Some(root) if !path.is_empty() && Path::new(path).is_relative() => {
            root.join(path).to_string_lossy().into_owned()
        }
        _ => path.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn a_file_in_the_folder_is_found_again_after_the_folder_moves() {
        let here = Path::new(r"E:\FTPeach");
        let stored = stored_path(r"e:\ftpeach\keys\id_ed25519", Some(here));
        assert_eq!(stored, r"keys\id_ed25519");
        assert_eq!(
            resolved_path(&stored, Some(Path::new(r"F:\Tools\FTPeach"))),
            r"F:\Tools\FTPeach\keys\id_ed25519"
        );
        // A file elsewhere, or a folder that only starts with the same name,
        // names one computer's drives and is kept as it is.
        for outside in [
            r"C:\Users\me\.ssh\id_ed25519",
            r"E:\FTPeach-old\keys\id",
            r"E:\FTPeach",
        ] {
            assert_eq!(stored_path(outside, Some(here)), outside);
            assert_eq!(resolved_path(outside, Some(here)), outside);
        }
        assert_eq!(resolved_path("", Some(here)), "");
        // An installed copy changes nothing.
        assert_eq!(
            stored_path(r"E:\FTPeach\keys\id", None),
            r"E:\FTPeach\keys\id"
        );
        assert_eq!(resolved_path(r"keys\id", None), r"keys\id");
    }

    #[test]
    fn only_the_marker_makes_a_folder_portable() {
        let dir = std::env::temp_dir().join(format!("ftpeach-portable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // A `data` folder alone is not a switch: nothing falls back to it.
        std::fs::create_dir_all(data_dir(&dir)).unwrap();
        assert_eq!(root_for(&dir), None);
        std::fs::write(dir.join(MARKER), b"").unwrap();
        assert_eq!(root_for(&dir), Some(dir.clone()));
        assert_eq!(local_dir(&dir), dir.join("data").join("local"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_data_folder_that_cannot_be_written_is_an_error() {
        let dir = std::env::temp_dir().join(format!("ftpeach-portable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        prepare(&data_dir(&dir)).unwrap();
        assert_eq!(std::fs::read_dir(data_dir(&dir)).unwrap().count(), 0);
        // A file where the folder should be stands in for a read-only disk.
        std::fs::write(dir.join("blocked"), b"").unwrap();
        assert!(prepare(&dir.join("blocked")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
