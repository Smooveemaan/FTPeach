//! Destructive-operation safety invariants shared by every local filesystem
//! command: canonical-path resolution, protected system/app directories,
//! filesystem roots, and the no-reparse-point traversal policy. FTPeach
//! intentionally remains a full local file manager, so destructive
//! operations are not restricted to roots selected through a dialog — the
//! safety boundary is instead invariant-based, enforced here rather than
//! left to renderer-side confirmation dialogs. See docs/security.md.

use anyhow::Context;
use std::path::{Component, Path, PathBuf};

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
            #[cfg(not(windows))]
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
                suffix.push(
                    ancestor
                        .file_name()
                        .context("path has no existing ancestor")?
                        .to_os_string(),
                );
                ancestor = ancestor.parent().context("path has no existing ancestor")?;
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

fn protected_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE").and_then(absolute_lexical) {
        paths.push(profile);
    }
    if let Some(app_data) = std::env::var_os("APPDATA")
        && let Some(data_dir) = absolute_lexical(PathBuf::from(app_data).join("FTPeach"))
    {
        paths.push(data_dir);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(app_dir) = exe.parent().and_then(absolute_lexical)
    {
        paths.push(app_dir);
    }
    paths
        .into_iter()
        .map(|path| resolved_path(&path).unwrap_or(path))
        .collect()
}

fn app_owned_paths() -> Vec<PathBuf> {
    app_owned_paths_for(
        std::env::var_os("APPDATA").map(PathBuf::from),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf)),
    )
}

fn app_owned_paths_for(app_data: Option<PathBuf>, app_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_data) = app_data
        && let Some(data_dir) = absolute_lexical(app_data.join("FTPeach"))
    {
        paths.push(data_dir);
    }
    if let Some(app_dir) = app_dir
        && let Some(app_dir) = absolute_lexical(app_dir)
    {
        paths.push(app_dir);
    }
    paths
        .into_iter()
        .map(|path| resolved_path(&path).unwrap_or(path))
        .collect()
}

/// Applies the source-side protections that
/// [`validate_write_destination`] applies to a copy destination.
///
/// This prevents copying the application's secret store into an exportable
/// location. Missing sources are left to the copy operation to report.
pub(crate) async fn validate_read_source(path: &Path) -> anyhow::Result<()> {
    let canonical = resolved_path(path)?;
    if app_owned_paths()
        .iter()
        .any(|protected| path_is_within(&canonical, protected))
    {
        anyhow::bail!("Refusing to read from the application or FTPeach data directory");
    }
    Ok(())
}

pub(crate) async fn validate_write_destination(path: &Path) -> anyhow::Result<()> {
    let absolute = resolved_path(path)?;
    if app_owned_paths()
        .iter()
        .any(|protected| path_is_within(&absolute, protected))
    {
        anyhow::bail!("Refusing to modify the application or FTPeach data directory");
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
            Ok(metadata) if is_reparse_point(&metadata) => {
                anyhow::bail!("Refusing to traverse a symbolic link, junction, or reparse point")
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

pub(crate) async fn ensure_tree_has_no_reparse_points(root: &Path) -> anyhow::Result<()> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if is_reparse_point(&metadata) {
            anyhow::bail!("Refusing to delete a symbolic link, junction, or reparse point");
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
    ensure_existing_components_no_reparse(path).await?;
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if is_reparse_point(&metadata) {
        anyhow::bail!("Refusing to delete a symbolic link, junction, or reparse point");
    }

    let canonical = tokio::fs::canonicalize(path).await?;
    if is_filesystem_root(&canonical) {
        anyhow::bail!("Refusing to delete a filesystem root");
    }
    if target_contains_protected_path(&canonical, &protected_paths())
        || app_owned_paths()
            .iter()
            .any(|protected| path_is_within(&canonical, protected))
    {
        anyhow::bail!("Refusing to delete a protected application or user directory");
    }
    if metadata.is_dir() {
        ensure_tree_has_no_reparse_points(&canonical).await?;
    }
    Ok(Some((canonical, metadata.is_dir())))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for target in [
            source.clone(),
            source.join("child"),
            source.join("missing/deep/child"),
            source.join("existing/../child"),
            PathBuf::from(source.to_string_lossy().to_uppercase()).join("child"),
        ] {
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

    #[test]
    fn recognizes_windows_drive_roots_but_not_children() {
        assert!(is_filesystem_root(Path::new(r"C:\")));
        assert!(!is_filesystem_root(Path::new(r"C:\Users")));
    }

    #[test]
    fn protects_exact_directories_and_all_of_their_ancestors() {
        let protected = vec![PathBuf::from(r"C:\Users\Alice\AppData\Roaming\FTPeach")];
        assert!(target_contains_protected_path(
            Path::new(r"C:\Users\Alice\AppData\Roaming\FTPeach"),
            &protected
        ));
        assert!(target_contains_protected_path(
            Path::new(r"C:\Users\Alice"),
            &protected
        ));
        assert!(!target_contains_protected_path(
            Path::new(r"C:\Users\Alice\Downloads"),
            &protected
        ));
    }

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

        let paths = app_owned_paths_for(Some(roaming), None);

        assert_eq!(paths, vec![protected]);
    }

    #[cfg(windows)]
    fn create_test_junction(target: &Path, junction: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(junction)
            .arg(target)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
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
        if !create_test_junction(&external, &junction) {
            let _ = std::fs::remove_dir_all(base);
            return;
        }

        let error = ensure_path_no_reparse_points_now(&junction.join("file.txt")).unwrap_err();
        assert!(error.to_string().contains("reparse point"));
        assert!(validate_copy_relationship(&root, &junction.join("child")).is_err());
        assert!(validate_copy_relationship(&external, &junction.join("child")).is_err());
        assert!(ensure_path_no_reparse_points_now(&junction.join("../file.txt")).is_err());

        std::fs::remove_dir(&junction).unwrap();
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
        if !create_test_junction(&external, &parent) {
            let _ = std::fs::remove_dir_all(base);
            return;
        }

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
}
