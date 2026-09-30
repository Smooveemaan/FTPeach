use crate::ipc::{CommandError, CommandResult, ErrorCode};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub struct ApprovedLocalPaths {
    paths: Arc<Mutex<HashSet<String>>>,
    network_paths: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenKind {
    Reveal,
    Document,
    Execute,
}

/// Shared with the renderer, which picks the open or execute command from it.
static EXECUTABLE_EXTENSIONS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../src/shared/executableExtensions.json"
    ))
    .expect("shared executable extensions must be a JSON array of strings")
});

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

pub fn is_network_path(path: &Path) -> bool {
    network_key(&path.to_string_lossy()).is_some()
}

/// The `\\server\share\…` a path names, purely from its text, lowercased so
/// two spellings of the same share compare equal.
///
/// Deciding this without touching the filesystem is the point. Resolving a
/// UNC path is itself network access: `canonicalize` and `metadata` make
/// Windows contact the server, and on a default configuration that hands it
/// an authentication attempt. So the question "is this a network path the
/// user allowed" has to be answered from the string, before any syscall.
fn network_key(text: &str) -> Option<String> {
    let value = text.replace('/', "\\");
    let lower = value.to_ascii_lowercase();
    // `\\?\UNC\server\share` is the same share as `\\server\share`.
    if let Some(rest) = lower.strip_prefix("\\\\?\\unc\\") {
        return Some(format!("\\\\{rest}"));
    }
    // A device or verbatim namespace is refused elsewhere and is not a share.
    if lower.starts_with("\\\\?\\") || lower.starts_with("\\\\.\\") {
        return None;
    }
    lower.starts_with("\\\\").then_some(lower)
}

fn key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    return value.to_lowercase();
    #[cfg(not(windows))]
    value
}

/// A canonical path as the shell and people read it: `C:\…` or
/// `\\server\share\…` rather than the `\\?\` form `canonicalize` returns.
pub fn shell_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

pub fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| EXECUTABLE_EXTENSIONS.contains(&ext.to_ascii_lowercase()))
}

fn canonicalize_user_path(path: &Path) -> CommandResult<PathBuf> {
    if is_device_path_text(&path.to_string_lossy()) {
        return Err(denied("Windows device paths are not allowed"));
    }
    std::fs::canonicalize(path).map_err(|_| denied("The selected path is unavailable"))
}

impl ApprovedLocalPaths {
    /// Refuses a network path the user has not chosen, from its text alone.
    ///
    /// Every entry point that is about to resolve, stat or open a local path
    /// calls this first. The later canonical check stays: it catches a path
    /// that only becomes a share once resolved, such as a local symlink
    /// pointing at one. This one catches the case that check cannot, where
    /// resolving the path is already the network access.
    pub fn preflight(&self, requested: &Path) -> CommandResult<()> {
        let text = requested.to_string_lossy();
        if is_device_path_text(&text) {
            return Err(denied("Windows device paths are not allowed"));
        }
        let Some(requested_key) = network_key(&text) else {
            return Ok(());
        };
        let confirmed = self
            .network_paths
            .lock()
            .map_err(|_| denied("Local path authorization is unavailable"))?
            .iter()
            .filter_map(|root| network_key(root))
            .any(|root| canonical_key_is_within(&requested_key, &root));
        if confirmed {
            Ok(())
        } else {
            Err(denied("Network paths require native-dialog confirmation"))
        }
    }

    pub fn approve_from_listing(&self, path: &Path) {
        if self.preflight(path).is_err() {
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

    /// Resolves a program Open with would launch. Unlike [`Self::validate`],
    /// appearing in a listing does not make a program acceptable: whether
    /// the user chose it is the confirmation's decision, not this check's.
    pub fn canonical_application(&self, requested: &Path) -> CommandResult<PathBuf> {
        self.preflight(requested)?;
        self.recheck_application(requested)
    }

    /// Repeats [`Self::canonical_application`] for a path it returned, which
    /// on Windows carries the `\\?\` prefix a user-typed path may not.
    pub fn recheck_application(&self, path: &Path) -> CommandResult<PathBuf> {
        let not_found = || {
            CommandError::new(
                ErrorCode::InvalidInput,
                "Configured application was not found",
            )
        };
        let canonical = std::fs::canonicalize(path).map_err(|_| not_found())?;
        if !canonical.is_file() || !is_executable(&canonical) {
            return Err(not_found());
        }
        if is_network_path(&canonical) {
            let canonical_key = key(&canonical);
            let confirmed = self
                .network_paths
                .lock()
                .map_err(|_| denied("Local path authorization is unavailable"))?
                .iter()
                .any(|root| canonical_key_is_within(&canonical_key, root));
            if !confirmed {
                return Err(denied("Network paths require native-dialog confirmation"));
            }
        }
        Ok(canonical)
    }

    pub fn validate(&self, requested: &Path, kind: OpenKind) -> CommandResult<PathBuf> {
        self.preflight(requested)?;
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
    fn shell_paths_drop_only_the_verbatim_prefix() {
        assert_eq!(
            shell_path(Path::new(r"\\?\C:\Tools\a.exe")),
            r"C:\Tools\a.exe"
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\UNC\srv\share\a.exe")),
            r"\\srv\share\a.exe"
        );
        assert_eq!(shell_path(Path::new(r"C:\Tools\a.exe")), r"C:\Tools\a.exe");
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

    #[test]
    fn listed_programs_are_resolved_but_documents_and_missing_files_are_not() {
        let root = std::env::temp_dir().join(format!("ftpeach-app-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let program = root.join("Editor.EXE");
        let document = root.join("notes.txt");
        std::fs::write(&program, b"MZ").unwrap();
        std::fs::write(&document, b"text").unwrap();
        let state = ApprovedLocalPaths::default();

        let canonical = state.canonical_application(&program).unwrap();
        assert_eq!(canonical, std::fs::canonicalize(&program).unwrap());
        assert_eq!(state.recheck_application(&canonical).unwrap(), canonical);
        for rejected in [document, root.join("missing.exe"), root.clone()] {
            assert_eq!(
                state.canonical_application(&rejected).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{}",
                rejected.display()
            );
        }
        assert_eq!(
            state
                .canonical_application(Path::new(r"\\?\C:\Windows\notepad.exe"))
                .unwrap_err()
                .code,
            ErrorCode::PermissionDenied
        );
        std::fs::remove_dir_all(root).unwrap();
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

#[cfg(test)]
mod preflight_tests {
    use super::*;

    /// A share nothing in the test environment can reach. A preflight that
    /// answered by touching the filesystem would hang or take seconds here;
    /// one that answers from the path's text returns immediately.
    const UNREACHABLE: &str = r"\\ftpeach-test-no-such-host\share\report.pdf";

    #[test]
    fn an_unconfirmed_share_is_refused_without_touching_the_filesystem() {
        let state = ApprovedLocalPaths::default();
        let started = std::time::Instant::now();
        let error = state.preflight(Path::new(UNREACHABLE)).unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert_eq!(
            error.message,
            "Network paths require native-dialog confirmation"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(200),
            "the preflight waited on the network: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_confirmed_share_covers_the_paths_below_it_in_either_spelling() {
        let state = ApprovedLocalPaths::default();
        state
            .network_paths
            .lock()
            .unwrap()
            .insert(key(Path::new(r"\\?\UNC\server\share")));

        for allowed in [
            r"\\server\share",
            r"\\SERVER\Share\report.pdf",
            r"\\server\share\sub\report.pdf",
            "//server/share/report.pdf",
        ] {
            assert!(state.preflight(Path::new(allowed)).is_ok(), "{allowed}");
        }
        // The grant is stored in the canonical spelling, but a path supplied
        // in the verbatim namespace stays refused as one, as it is
        // everywhere else: that is how a device path would be smuggled in.
        assert_eq!(
            state
                .preflight(Path::new(r"\\?\UNC\server\share\report.pdf"))
                .unwrap_err()
                .message,
            "Windows device paths are not allowed"
        );
        for refused in [
            r"\\server\other\report.pdf",
            r"\\server\shareholder\report.pdf",
            r"\\other\share\report.pdf",
        ] {
            assert!(state.preflight(Path::new(refused)).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_local_path_needs_no_confirmation_and_a_device_path_is_refused() {
        let state = ApprovedLocalPaths::default();
        assert!(state.preflight(Path::new(r"C:\reports\report.pdf")).is_ok());
        assert!(state.preflight(Path::new("reports/report.pdf")).is_ok());
        for device in [r"\\?\C:\reports\report.pdf", r"\\.\PhysicalDrive0"] {
            assert_eq!(
                state.preflight(Path::new(device)).unwrap_err().message,
                "Windows device paths are not allowed",
                "{device}"
            );
        }
    }
}
