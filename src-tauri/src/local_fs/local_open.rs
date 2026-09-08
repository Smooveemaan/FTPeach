use crate::ipc::{CommandError, CommandResult, ErrorCode};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
pub struct ApprovedLocalPaths {
    paths: Mutex<HashSet<String>>,
    network_paths: Mutex<HashSet<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenKind {
    Reveal,
    Document,
    Execute,
}

const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "msi",
    "msp",
    "mst",
    "lnk",
    "url",
    "hta",
    "js",
    "jse",
    "vbs",
    "vbe",
    "wsf",
    "wsh",
    "scr",
    "cpl",
    "reg",
    "inf",
    "scf",
    "application",
    "appref-ms",
    "gadget",
    "jar",
    "chm",
    "iso",
];

fn denied(message: &str) -> CommandError {
    CommandError::new(ErrorCode::PermissionDenied, message)
}

fn is_device_path_text(value: &str) -> bool {
    let value = value.replace('/', "\\");
    let lower = value.to_ascii_lowercase();
    lower.starts_with("\\\\?\\")
        || lower.starts_with("\\\\.\\")
        || lower.starts_with("\\??\\")
        || lower.starts_with("\\device\\")
}

fn is_network_path(path: &Path) -> bool {
    let value = path.to_string_lossy().replace('/', "\\");
    let lower = value.to_ascii_lowercase();
    lower.starts_with("\\\\?\\unc\\")
        || (value.starts_with("\\\\")
            && !lower.starts_with("\\\\?\\")
            && !lower.starts_with("\\\\.\\"))
}

fn key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    return value.to_lowercase();
    #[cfg(not(windows))]
    value
}

pub fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| EXECUTABLE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn canonicalize_user_path(path: &Path) -> CommandResult<PathBuf> {
    if is_device_path_text(&path.to_string_lossy()) {
        return Err(denied("Windows device paths are not allowed"));
    }
    std::fs::canonicalize(path).map_err(|_| denied("The selected path is unavailable"))
}

impl ApprovedLocalPaths {
    pub fn approve_from_listing(&self, path: &Path) {
        if is_device_path_text(&path.to_string_lossy()) {
            return;
        }
        if let Ok(canonical) = std::fs::canonicalize(path) {
            if is_network_path(&canonical) {
                let confirmed = self.network_paths.lock().ok().is_some_and(|paths| {
                    paths
                        .iter()
                        .any(|root| canonical_key_is_within(&key(&canonical), root))
                });
                if !confirmed {
                    return;
                }
            }
            if let Ok(mut paths) = self.paths.lock() {
                paths.insert(key(&canonical));
            }
        }
    }

    pub fn approve_from_dialog(&self, path: &Path) {
        if is_device_path_text(&path.to_string_lossy()) {
            return;
        }
        if let Ok(canonical) = std::fs::canonicalize(path) {
            let canonical_key = key(&canonical);
            if let Ok(mut paths) = self.paths.lock() {
                paths.insert(canonical_key.clone());
            }
            if is_network_path(&canonical)
                && let Ok(mut paths) = self.network_paths.lock()
            {
                paths.insert(canonical_key);
            }
        }
    }

    pub fn validate(&self, requested: &Path, kind: OpenKind) -> CommandResult<PathBuf> {
        let canonical = canonicalize_user_path(requested)?;
        self.validate_canonical(canonical, kind)
    }

    fn validate_canonical(&self, canonical: PathBuf, kind: OpenKind) -> CommandResult<PathBuf> {
        let canonical_key = key(&canonical);
        let approved = self
            .paths
            .lock()
            .map_err(|_| denied("Local path authorization is unavailable"))?
            .contains(&canonical_key);
        if !approved {
            return Err(denied(
                "The path must be selected in FTPeach or by a native file dialog",
            ));
        }
        if is_network_path(&canonical)
            && !self
                .network_paths
                .lock()
                .map_err(|_| denied("Local path authorization is unavailable"))?
                .iter()
                .any(|root| canonical_key_is_within(&canonical_key, root))
        {
            return Err(denied("Network paths require native-dialog confirmation"));
        }
        let executable = is_executable(&canonical);
        match (kind, executable) {
            (OpenKind::Document, true) => Err(denied(
                "Executable content must use the explicit execute command",
            )),
            (OpenKind::Execute, false) => Err(CommandError::new(
                ErrorCode::InvalidInput,
                "The selected file is not an executable or script type",
            )),
            _ => Ok(canonical),
        }
    }
}

fn canonical_key_is_within(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_and_script_extensions_are_classified_case_insensitively() {
        for name in [
            "a.exe", "a.CMD", "a.ps1", "a.msi", "a.lnk", "a.url", "a.hta", "a.js", "a.vbs",
        ] {
            assert!(is_executable(Path::new(name)), "{name}");
        }
        assert!(!is_executable(Path::new("report.pdf")));
    }

    #[test]
    fn device_path_spellings_are_rejected() {
        for path in [
            r"\\?\C:\a.txt",
            r"\\.\C:\a.txt",
            r"\??\C:\a.txt",
            r"\Device\HarddiskVolume1\a.txt",
        ] {
            assert!(is_device_path_text(path), "{path}");
        }
    }

    #[test]
    fn device_paths_are_rejected_before_filesystem_access() {
        let error = canonicalize_user_path(Path::new(r"\\?\C:\missing\report.pdf")).unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert_eq!(error.message, "Windows device paths are not allowed");
    }

    #[test]
    fn unc_paths_are_recognized_as_network_paths() {
        assert!(is_network_path(Path::new(r"\\server\share\report.pdf")));
        assert!(is_network_path(Path::new(
            r"\\?\UNC\server\share\report.pdf"
        )));
        assert!(!is_network_path(Path::new(r"C:\reports\report.pdf")));
    }

    #[test]
    fn unc_open_requires_native_dialog_confirmation() {
        let path = PathBuf::from(r"\\server\share\report.pdf");
        let state = ApprovedLocalPaths::default();
        state.paths.lock().unwrap().insert(key(&path));

        let error = state
            .validate_canonical(path.clone(), OpenKind::Document)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert_eq!(
            error.message,
            "Network paths require native-dialog confirmation"
        );

        state
            .network_paths
            .lock()
            .unwrap()
            .insert(key(Path::new(r"\\server\share")));
        assert_eq!(
            state
                .validate_canonical(path.clone(), OpenKind::Document)
                .unwrap(),
            path
        );
    }

    #[test]
    fn arbitrary_existing_path_is_not_accepted() {
        let file = std::env::temp_dir().join(format!("ftpeach-open-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"test").unwrap();
        let state = ApprovedLocalPaths::default();
        assert_eq!(
            state.validate(&file, OpenKind::Document).unwrap_err().code,
            ErrorCode::PermissionDenied
        );
        state.approve_from_listing(&file);
        assert!(state.validate(&file, OpenKind::Document).is_ok());
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn executable_cannot_be_opened_as_a_document() {
        let file = std::env::temp_dir().join(format!("ftpeach-open-{}.cmd", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"echo test").unwrap();
        let state = ApprovedLocalPaths::default();
        state.approve_from_listing(&file);
        assert_eq!(
            state.validate(&file, OpenKind::Document).unwrap_err().code,
            ErrorCode::PermissionDenied
        );
        assert!(state.validate(&file, OpenKind::Execute).is_ok());
        let _ = std::fs::remove_file(file);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_resolved_to_its_canonical_target() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("ftpeach-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        std::fs::write(&target, b"test").unwrap();
        symlink(&target, &link).unwrap();
        let state = ApprovedLocalPaths::default();
        state.approve_from_listing(&link);
        assert_eq!(
            state.validate(&link, OpenKind::Document).unwrap(),
            std::fs::canonicalize(target).unwrap()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_symlink_is_resolved_to_its_canonical_target() {
        use std::os::windows::fs::symlink_file;

        let root = std::env::temp_dir().join(format!("ftpeach-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        std::fs::write(&target, b"test").unwrap();
        if let Err(error) = symlink_file(&target, &link) {
            if error.raw_os_error() == Some(1314) {
                eprintln!("skipping symlink assertion: Windows symlink privilege is unavailable");
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            panic!("creating test symlink failed: {error}");
        }

        let state = ApprovedLocalPaths::default();
        state.approve_from_listing(&link);
        assert_eq!(
            state.validate(&link, OpenKind::Document).unwrap(),
            std::fs::canonicalize(&target).unwrap()
        );

        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_is_resolved_to_its_canonical_target() {
        let root = std::env::temp_dir().join(format!("ftpeach-open-{}", uuid::Uuid::new_v4()));
        let target_dir = root.join("target");
        let junction = root.join("junction");
        std::fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("report.txt");
        std::fs::write(&target, b"test").unwrap();

        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target_dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let through_junction = junction.join("report.txt");
        let state = ApprovedLocalPaths::default();
        state.approve_from_listing(&through_junction);
        assert_eq!(
            state
                .validate(&through_junction, OpenKind::Document)
                .unwrap(),
            std::fs::canonicalize(&target).unwrap()
        );

        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
