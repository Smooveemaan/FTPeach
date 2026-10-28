//! Destructive-operation safety invariants shared by every local filesystem
//! command: canonical-path resolution, protected system/app directories,
//! filesystem roots, and the no-reparse-point traversal policy. FTPeach
//! intentionally remains a full local file manager, so destructive
//! operations are not restricted to roots selected through a dialog — the
//! safety boundary is instead invariant-based, enforced here rather than
//! left to renderer-side confirmation dialogs. See docs/security.md.

use anyhow::Context;
use std::path::{Component, Path, PathBuf};

/// A refusal the user is told about as one, rather than as an unexpected error.
fn refused(message: &str) -> anyhow::Error {
    crate::ipc::CommandError::new(crate::ipc::ErrorCode::PermissionDenied, message).into()
}

/// A delete that would reach a link, which is never followed: told as such,
/// not as a missing permission.
fn link_refused() -> anyhow::Error {
    crate::ipc::CommandError::new(
        crate::ipc::ErrorCode::LinkNotFollowed,
        "Refusing to delete a symbolic link, junction, or reparse point",
    )
    .into()
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

pub(crate) fn is_filesystem_root(path: &Path) -> bool {
    path.has_root() && path.parent().is_none()
}

fn target_contains_protected_path(target: &Path, protected_paths: &[PathBuf]) -> bool {
    protected_paths
        .iter()
        .any(|protected| path_is_within(protected, target))
}

// Compare parsed prefixes, not a stripped string: verbatim disk/UNC prefixes
// have ordinary equivalents, while device namespaces do not.
fn comparison_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        let mut result = PathBuf::new();
        for component in path.components() {
            match component {
                Component::Prefix(prefix) => match prefix.kind() {
                    Prefix::VerbatimDisk(drive) | Prefix::Disk(drive) => {
                        result.push(format!("{}:", drive as char))
                    }
                    Prefix::VerbatimUNC(server, share) | Prefix::UNC(server, share) => {
                        let mut unc = std::ffi::OsString::from(r"\\");
                        unc.push(server);
                        unc.push(r"\");
                        unc.push(share);
                        result.push(unc);
                    }
                    _ => result.push(component.as_os_str()),
                },
                _ => result.push(component.as_os_str()),
            }
        }
        result
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

pub(crate) fn path_starts_with(path: &Path, base: &Path) -> bool {
    let path = comparison_path(path);
    let base = comparison_path(base);
    let mut components = path.components();
    base.components().all(|expected| {
        components.next().is_some_and(|actual| {
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
                let actual: Vec<_> = actual.as_os_str().encode_wide().collect();
                let expected: Vec<_> = expected.as_os_str().encode_wide().collect();
                // SAFETY: both slices remain alive and carry their explicit lengths.
                unsafe { CompareStringOrdinal(&actual, &expected, true) == CSTR_EQUAL }
            }
            // shortcut: macOS volumes are usually case-insensitive, so case is
            // ignored on every one there; a case-sensitive volume gets an extra
            // refusal, never a missed one. Ask the volume if that matters.
            #[cfg(target_os = "macos")]
            {
                actual == expected
                    || actual.as_os_str().to_string_lossy().to_lowercase()
                        == expected.as_os_str().to_string_lossy().to_lowercase()
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                actual == expected
            }
        })
    })
}

/// Local drive paths and SMB aliases can name the same directory without
/// sharing a textual prefix. Compare existing ancestor identities as well,
/// retaining the suffix when the protected directory has not been created yet.
fn path_is_within(path: &Path, base: &Path) -> bool {
    if path_starts_with(path, base) {
        return true;
    }
    #[cfg(windows)]
    {
        let Some((base_ancestor, identity)) = base
            .ancestors()
            .find_map(|ancestor| file_identity(ancestor).map(|id| (ancestor, id)))
        else {
            return false;
        };
        let Ok(base_suffix) = base.strip_prefix(base_ancestor) else {
            return false;
        };
        for ancestor in path.ancestors() {
            if file_identity(ancestor) == Some(identity) {
                return path
                    .strip_prefix(ancestor)
                    .is_ok_and(|suffix| path_starts_with(suffix, base_suffix));
            }
        }
    }
    false
}

#[cfg(windows)]
fn file_identity(path: &Path) -> Option<(u32, u32, u32)> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(7)
        .custom_flags(0x0200_0000 | 0x0020_0000)
        .open(path)
        .ok()?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the owned file keeps the handle valid; the output points to an
    // initialized structure for the duration of the synchronous call.
    unsafe {
        GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information).ok()?;
    }
    Some((
        information.dwVolumeSerialNumber,
        information.nFileIndexHigh,
        information.nFileIndexLow,
    ))
}

/// Resolves existing ancestors (including short-name aliases), retaining a
/// missing suffix. Reparse components are rejected before identity is used.
pub(crate) fn resolved_path(path: &Path) -> anyhow::Result<PathBuf> {
    ensure_path_no_reparse_points_now(path)?;
    let absolute = absolute_lexical(path).context("path cannot be made absolute")?;
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    loop {
        match std::fs::canonicalize(ancestor) {
            Ok(mut canonical) => {
                for name in suffix.iter().rev() {
                    canonical.push(name);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Nothing of it exists, not even its drive or share: one
                // unplugged or taken away, which is a missing path to the
                // user, not an unexpected failure.
                let (Some(name), Some(parent)) = (ancestor.file_name(), ancestor.parent()) else {
                    return Err(crate::ipc::CommandError::new(
                        crate::ipc::ErrorCode::NotFound,
                        "path has no existing ancestor",
                    )
                    .into());
                };
                suffix.push(name.to_os_string());
                ancestor = parent;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(crate) fn validate_copy_relationship(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let source = resolved_path(source)?;
    let destination = resolved_path(destination)?;
    anyhow::ensure!(
        !path_is_within(&destination, &source),
        "{}: Destination is the source or is inside the source folder",
        destination.display()
    );
    Ok(())
}

fn absolute_lexical(path: impl Into<PathBuf>) -> Option<PathBuf> {
    let path = path.into();
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized)
}

/// Resolved once, like [`app_owned_paths`]: the profile, the data folder and
/// the program folder stay put while the program runs.
fn protected_paths() -> &'static [PathBuf] {
    static PATHS: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    PATHS.get_or_init(resolve_protected_paths)
}

/// The system's own folders: deleting one, or a folder holding one, is refused
/// like deleting the profile. `/` is a filesystem root and refused as such.
#[cfg(not(windows))]
const SYSTEM_DIRS: &[&str] = &[
    "/System", "/usr", "/bin", "/etc", "/Library", "/proc", "/sys", "/dev",
];
#[cfg(windows)]
const SYSTEM_DIRS: &[&str] = &[];

fn resolve_protected_paths() -> Vec<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    [home.and_then(absolute_lexical), data_dir(), app_dir()]
        .into_iter()
        .flatten()
        .chain(SYSTEM_DIRS.iter().map(PathBuf::from))
        .map(|path| resolved_path(&path).unwrap_or(path))
        .collect()
}

/// `Store::default_dir`, which this module may not name; the public-command
/// test in `commands::fs` keeps the two the same.
fn data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let dir = PathBuf::from(std::env::var_os("APPDATA")?).join("FTPeach");
    #[cfg(not(windows))]
    let dir = dirs::data_dir()?.join("com.smooveemaan.ftpeach");
    absolute_lexical(dir)
}

/// The program's folder; on macOS the whole `.app` bundle, not only the
/// `Contents/MacOS` folder that holds the executable.
fn app_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(target_os = "macos")]
    let dir = dir
        .ancestors()
        .find(|folder| folder.extension().is_some_and(|ext| ext == "app"))
        .unwrap_or(dir);
    absolute_lexical(dir)
}

/// Resolved once: they stay put while the program runs, and resolving them
/// for every check cost a folder of small files milliseconds per file.
fn app_owned_paths() -> &'static [PathBuf] {
    static PATHS: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    PATHS.get_or_init(|| {
        // Outside Windows the staged update sits in the data folder.
        let staging = std::env::var_os("LOCALAPPDATA")
            .filter(|_| cfg!(windows))
            .map(|local| PathBuf::from(local).join(UPDATE_STAGING));
        app_owned_paths_for(data_dir(), staging, app_dir())
    })
}

/// The downloaded update waits under the local app data; file operations
/// must not be able to replace it between its check and its start.
const UPDATE_STAGING: &str = "com.smooveemaan.ftpeach/updates";

fn app_owned_paths_for(
    data_dir: Option<PathBuf>,
    staging: Option<PathBuf>,
    app_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    [data_dir, staging, app_dir]
        .into_iter()
        .flatten()
        .filter_map(absolute_lexical)
        .map(|path| resolved_path(&path).unwrap_or(path))
        .collect()
}

/// The folders of the local data that hold the user's own files: copies
/// opened in an editor and edits recovered from one.
const WORKING_FOLDERS: [&str; 2] = ["edit-sessions", "recovered-edits"];

fn is_app_owned(path: &Path) -> bool {
    app_owned_paths()
        .iter()
        .any(|protected| path_is_within(path, protected))
        && !is_working_copy(path, working_local_dir())
}

/// The local data inside a protected folder: a portable copy's `data\local`
/// beside the program, and outside Windows the data folder, which is also
/// Tauri's local data folder.
fn working_local_dir() -> Option<&'static Path> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| working_local_dir_for(super::portable::root()))
        .as_deref()
}

fn working_local_dir_for(portable_root: Option<&Path>) -> Option<PathBuf> {
    let local = match portable_root {
        Some(root) => super::portable::local_dir(root),
        None => data_dir().filter(|_| !cfg!(windows))?,
    };
    Some(resolved_path(&local).unwrap_or(local))
}

/// Editor copies are downloaded, edited and uploaded like any other file, so
/// they are let through; the staged update and the data beside them are not.
fn is_working_copy(path: &Path, local: Option<&Path>) -> bool {
    local.is_some_and(|local| {
        WORKING_FOLDERS
            .iter()
            .any(|folder| path_is_within(path, &local.join(folder)))
    })
}

/// Applies the source-side protections that
/// [`validate_write_destination`] applies to a copy destination.
///
/// This prevents copying the application's secret store into an exportable
/// location. Missing sources are left to the copy operation to report.
pub(crate) async fn validate_read_source(path: &Path) -> anyhow::Result<()> {
    let canonical = resolved_path(path)?;
    if is_app_owned(&canonical) {
        return Err(refused(
            "Refusing to read from the application or FTPeach data directory",
        ));
    }
    Ok(())
}

pub(crate) async fn validate_write_destination(path: &Path) -> anyhow::Result<()> {
    let absolute = resolved_path(path)?;
    if is_app_owned(&absolute) {
        return Err(refused(
            "Refusing to modify the application or FTPeach data directory",
        ));
    }
    Ok(())
}

async fn ensure_existing_components_no_reparse(path: &Path) -> anyhow::Result<()> {
    ensure_path_no_reparse_points_now(path)
}

/// Re-checks the path synchronously so callers can place the check directly
/// next to a path-based filesystem operation without an `.await` scheduling
/// point in between. On Windows every existing component is opened with
/// `FILE_FLAG_OPEN_REPARSE_POINT`, so metadata describes the component itself
/// instead of a junction/symlink target.
pub(crate) fn ensure_path_no_reparse_points_now(path: &Path) -> anyhow::Result<()> {
    // Inspect components before collapsing '..': a junction followed by '..'
    // must not disappear from the no-traversal check.
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        // A Windows prefix (`C:` or `\\?\C:`) is not a filesystem object on
        // its own. The following RootDir component produces the openable
        // volume root (`C:\` / `\\?\C:\`).
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        match component_metadata_no_follow(&current) {
            Ok(metadata) if is_reparse_point(&metadata) && !is_system_link(&current, &metadata) => {
                return Err(crate::ipc::CommandError::new(
                    crate::ipc::ErrorCode::LinkNotFollowed,
                    "Refusing to traverse a symbolic link, junction, or reparse point",
                )
                .into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn component_metadata_no_follow(path: &Path) -> std::io::Result<std::fs::Metadata> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?
        .metadata()
}

#[cfg(not(windows))]
fn component_metadata_no_follow(path: &Path) -> std::io::Result<std::fs::Metadata> {
    std::fs::symlink_metadata(path)
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// A link the system keeps, such as macOS's `/var` -> `/private/var` or
/// `/bin` -> `usr/bin` on Linux: root's own, in a folder only root can
/// change, so it cannot be swapped between a check and its use. The parent
/// was already checked, so following it here is safe.
#[cfg(not(windows))]
fn is_system_link(path: &Path, metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.uid() == 0
        && path
            .parent()
            .and_then(|parent| std::fs::metadata(parent).ok())
            .is_some_and(|parent| parent.uid() == 0 && parent.mode() & 0o022 == 0)
}

#[cfg(windows)]
fn is_system_link(_path: &Path, _metadata: &std::fs::Metadata) -> bool {
    false
}

pub(crate) async fn ensure_tree_has_no_reparse_points(root: &Path) -> anyhow::Result<()> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if is_reparse_point(&metadata) {
            return Err(link_refused());
        }
        if !metadata.is_dir() {
            continue;
        }
        let mut entries = tokio::fs::read_dir(&path).await?;
        while let Some(entry) = entries.next_entry().await? {
            pending.push(entry.path());
        }
    }
    Ok(())
}

pub(crate) async fn validated_delete_target(
    path: &Path,
) -> anyhow::Result<Option<(PathBuf, bool)>> {
    validated_target(path, true).await
}

/// A rename within a volume moves the folder's own entry and leaves a
/// junction inside it, and what the junction points to, untouched; only a
/// delete has to refuse one anywhere in the tree.
pub(crate) async fn validated_rename_source(
    path: &Path,
) -> anyhow::Result<Option<(PathBuf, bool)>> {
    validated_target(path, false).await
}

async fn validated_target(
    path: &Path,
    whole_tree: bool,
) -> anyhow::Result<Option<(PathBuf, bool)>> {
    ensure_existing_components_no_reparse(path).await?;
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if is_reparse_point(&metadata) {
        return Err(link_refused());
    }

    let canonical = tokio::fs::canonicalize(path).await?;
    if is_filesystem_root(&canonical) {
        return Err(refused("Refusing to delete a filesystem root"));
    }
    if target_contains_protected_path(&canonical, protected_paths()) || is_app_owned(&canonical) {
        return Err(refused(
            "Refusing to delete a protected application or user directory",
        ));
    }
    if whole_tree && metadata.is_dir() {
        ensure_tree_has_no_reparse_points(&canonical).await?;
    }
    Ok(Some((canonical, metadata.is_dir())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_prefix_and_case_comparisons_preserve_component_boundaries() {
        for (path, base) in [
            (r"\\?\C:\USERS\Alice\data\file", r"c:\users\alice\DATA"),
            (r"\\?\UNC\SERVER\Share\data\file", r"\\server\share\DATA"),
            (r"\\server\share\data\file", r"\\?\UNC\SERVER\SHARE\data"),
        ] {
            assert!(
                path_starts_with(Path::new(path), Path::new(base)),
                "{path} / {base}"
            );
        }
        assert!(!path_starts_with(
            Path::new(r"C:\data-other"),
            Path::new(r"C:\data")
        ));
        assert!(!path_starts_with(
            Path::new(r"\\server\share2\data"),
            Path::new(r"\\server\share")
        ));
    }

    #[tokio::test]
    async fn copy_relationship_rejects_descendants_before_creating_anything() {
        let root = std::env::temp_dir().join(format!("ftpeach-copy-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        std::fs::create_dir_all(source.join("existing")).unwrap();
        std::fs::write(source.join("existing/keep"), b"keep").unwrap();
        let mut targets = vec![
            source.clone(),
            source.join("child"),
            source.join("missing/deep/child"),
            source.join("existing/../child"),
        ];
        // Linux volumes tell names apart by case.
        if cfg!(any(windows, target_os = "macos")) {
            targets.push(PathBuf::from(source.to_string_lossy().to_uppercase()).join("child"));
        }
        for target in targets {
            assert!(
                validate_copy_relationship(&source, &target).is_err(),
                "{}",
                target.display()
            );
        }
        assert!(validate_copy_relationship(&source, &root.join("sibling")).is_ok());
        assert_eq!(
            std::fs::read(source.join("existing/keep")).unwrap(),
            b"keep"
        );
        assert!(!source.join("child").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// An absolute path on this system, written with `/`.
    fn absolute(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:{path}"))
        } else {
            PathBuf::from(path)
        }
    }

    #[test]
    fn recognizes_drive_roots_but_not_children() {
        assert!(is_filesystem_root(&absolute("/")));
        assert!(!is_filesystem_root(&absolute("/Users")));
    }

    #[test]
    fn protects_exact_directories_and_all_of_their_ancestors() {
        let protected = vec![absolute("/Users/Alice/AppData/Roaming/FTPeach")];
        assert!(target_contains_protected_path(
            &absolute("/Users/Alice/AppData/Roaming/FTPeach"),
            &protected
        ));
        assert!(target_contains_protected_path(
            &absolute("/Users/Alice"),
            &protected
        ));
        assert!(!target_contains_protected_path(
            &absolute("/Users/Alice/Downloads"),
            &protected
        ));
    }

    #[cfg(windows)]
    #[test]
    fn reparse_attribute_is_the_windows_junction_and_symlink_boundary() {
        assert_ne!(FILE_ATTRIBUTE_REPARSE_POINT & 0x400, 0);
        assert_eq!(FILE_ATTRIBUTE_REPARSE_POINT & 0x20, 0);
    }

    #[tokio::test]
    async fn canonicalizes_dot_dot_before_allowing_a_normal_file_delete() {
        let root = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let nested = root.join("nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        let file = root.join("normal.txt");
        tokio::fs::write(&file, b"test").await.unwrap();

        let target = validated_delete_target(&nested.join("..").join("normal.txt"))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(target.0, std::fs::canonicalize(&file).unwrap());
        assert!(!target.1);
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn absolute_protected_path_does_not_need_to_exist() {
        let root = std::env::temp_dir().join(format!("ftpeach-missing-{}", uuid::Uuid::new_v4()));
        let protected = absolute_lexical(root.join("FTPeach")).unwrap();
        assert!(!protected.exists());
        assert!(target_contains_protected_path(
            &protected,
            std::slice::from_ref(&protected)
        ));
        assert!(target_contains_protected_path(&root, &[protected]));
    }

    #[test]
    fn missing_app_data_directory_is_still_protected() {
        let temp = std::env::temp_dir();
        let missing = format!("ftpeach-missing-{}", uuid::Uuid::new_v4());
        let roaming = temp.join(&missing);
        // TEMP may contain a Windows short-name alias; protection resolves the
        // existing ancestor while retaining the missing directory suffix.
        let protected = std::fs::canonicalize(&temp)
            .unwrap()
            .join(&missing)
            .join("FTPeach");
        assert!(!protected.exists());

        let paths = app_owned_paths_for(Some(roaming.join("FTPeach")), None, None);

        assert_eq!(paths, vec![protected]);
    }

    #[test]
    fn the_update_staging_folder_is_protected_but_not_the_rest_of_local_data() {
        let local = std::env::temp_dir().join(format!("ftpeach-local-{}", uuid::Uuid::new_v4()));
        let paths = app_owned_paths_for(None, Some(local.join(UPDATE_STAGING)), None);
        // Callers resolve the path first; on macOS that turns /var into /private/var.
        let staging =
            resolved_path(&local.join("com.smooveemaan.ftpeach/updates/FTPeach-9.9.9-setup.exe"))
                .unwrap();
        let recovered =
            resolved_path(&local.join("com.smooveemaan.ftpeach/recovered-edits/a/notes.txt"))
                .unwrap();
        assert!(paths.iter().any(|root| path_is_within(&staging, root)));
        assert!(!paths.iter().any(|root| path_is_within(&recovered, root)));
    }

    #[test]
    fn a_portable_copy_lets_editor_copies_through_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("ftpeach-portable-{}", uuid::Uuid::new_v4()));
        let local = super::super::portable::local_dir(&root);
        let resolved_local = working_local_dir_for(Some(&root)).unwrap();
        assert_eq!(resolved_local, resolved_path(&local).unwrap());
        // An installed copy keeps editor copies in its data folder only
        // outside Windows; on Windows that folder holds no editor copies.
        assert_eq!(working_local_dir_for(None).is_some(), !cfg!(windows));
        let within = |path: PathBuf| {
            let path = resolved_path(&path).unwrap();
            is_working_copy(&path, Some(&resolved_local))
        };
        assert!(within(local.join("edit-sessions/run/file/notes.txt")));
        assert!(within(local.join("recovered-edits/a/file/notes.txt")));
        assert!(!within(local.join("updates/FTPeach-9.9.9-portable.zip")));
        assert!(!within(local.join("edit-sessions/../updates/pending.json")));
        assert!(!within(root.join("data/vault.dat")));
        assert!(!within(root.join("FTPeach.exe")));
        assert!(!is_working_copy(
            &local.join("edit-sessions/run/notes.txt"),
            None
        ));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn system_folders_and_the_home_folder_are_not_deleted() {
        // Not `/etc`: on macOS it is a link and refused as one.
        for folder in ["/usr", "/dev"]
            .into_iter()
            .map(PathBuf::from)
            .chain(std::env::var_os("HOME").map(PathBuf::from))
        {
            let error = validated_delete_target(&folder).await.unwrap_err();
            assert_eq!(
                crate::ipc::CommandError::from_anyhow(&error).code,
                crate::ipc::ErrorCode::PermissionDenied,
                "{}",
                folder.display()
            );
        }
    }

    #[cfg(windows)]
    /// A junction needs no privilege, so failing to make one is a broken
    /// fixture and fails the test rather than skipping it.
    fn create_test_junction(target: &Path, junction: &Path) {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(junction)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn handle_check_rejects_a_nested_junction() {
        let base = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        let external = base.join("external");
        let junction = root.join("nested").join("junction");
        std::fs::create_dir_all(junction.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        create_test_junction(&external, &junction);

        let error = ensure_path_no_reparse_points_now(&junction.join("file.txt")).unwrap_err();
        assert!(error.to_string().contains("reparse point"));
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::LinkNotFollowed
        );
        assert!(validate_copy_relationship(&root, &junction.join("child")).is_err());
        assert!(validate_copy_relationship(&external, &junction.join("child")).is_err());
        assert!(ensure_path_no_reparse_points_now(&junction.join("../file.txt")).is_err());

        std::fs::remove_dir(&junction).unwrap();
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn a_path_on_a_drive_that_is_not_there_is_not_found() {
        let missing = ('D'..='Z')
            .map(|letter| PathBuf::from(format!("{letter}:\\")))
            .find(|root| !root.exists())
            .expect("a free drive letter");
        let error = resolved_path(&missing.join("folder")).unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::NotFound,
            "{error:#}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_path_on_a_share_that_is_not_there_is_not_found() {
        let share = PathBuf::from(r"\\localhost\ftpeach-no-such-share\folder");
        let error = resolved_path(&share).unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::NotFound,
            "{error:#}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_folder_with_a_junction_inside_can_be_renamed_but_not_deleted() {
        let base = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let folder = base.join("folder");
        let external = base.join("external");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        create_test_junction(&external, &folder.join("link"));

        assert!(validated_rename_source(&folder).await.unwrap().is_some());
        let error = validated_delete_target(&folder).await.unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::LinkNotFollowed
        );

        std::fs::remove_dir(folder.join("link")).unwrap();
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn repeated_check_rejects_component_substitution_after_validation() {
        let base = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let parent = base.join("parent");
        let external = base.join("external");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let destination = parent.join("file.txt");
        validate_write_destination(&destination).await.unwrap();

        std::fs::remove_dir(&parent).unwrap();
        create_test_junction(&external, &parent);

        let error = ensure_path_no_reparse_points_now(&destination).unwrap_err();
        assert!(error.to_string().contains("reparse point"));

        std::fs::remove_dir(&parent).unwrap();
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn guarded_recursive_delete_rejects_a_directory_symlink() {
        use std::os::windows::fs::symlink_dir;

        let base = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("delete-target");
        let external = base.join("must-survive");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&external).await.unwrap();
        tokio::fs::write(external.join("file.txt"), b"keep")
            .await
            .unwrap();
        if let Err(error) = symlink_dir(&external, root.join("link")) {
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314)
            {
                // A developer without Developer Mode may lack the privilege;
                // CI runs elevated, where a skip would hide a broken fixture.
                assert!(
                    std::env::var_os("CI").is_none(),
                    "CI could not create a symlink: {error}"
                );
                let _ = tokio::fs::remove_dir_all(base).await;
                return;
            }
            panic!("creating test symlink failed: {error}");
        }

        let error = ensure_tree_has_no_reparse_points(&root).await.unwrap_err();
        assert!(error.to_string().contains("reparse point"));
        assert!(external.join("file.txt").exists());

        let _ = tokio::fs::remove_dir_all(base).await;
    }

    /// The links the system keeps (macOS `/var`, `/tmp`; `/bin`, `/lib` on
    /// most Linux systems) are crossed; a link anyone else made is not.
    #[cfg(not(windows))]
    #[test]
    fn system_links_are_crossed_and_other_links_are_not() {
        let system: Vec<_> = ["/var", "/tmp", "/etc", "/bin", "/lib"]
            .into_iter()
            .filter(|path| {
                std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
            })
            .collect();
        assert!(!system.is_empty(), "no system link to try on this machine");
        for link in system {
            ensure_path_no_reparse_points_now(&Path::new(link).join("child")).unwrap();
        }

        let root = std::env::temp_dir().join(format!("ftpeach-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        let error = ensure_path_no_reparse_points_now(&root.join("link/file")).unwrap_err();
        assert_eq!(
            crate::ipc::CommandError::from_anyhow(&error).code,
            crate::ipc::ErrorCode::LinkNotFollowed
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
