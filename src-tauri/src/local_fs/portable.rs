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

#[cfg(test)]
mod tests {
    use super::*;

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
