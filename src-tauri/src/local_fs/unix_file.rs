//! Descriptor checks before removing a Unix directory entry. Unix cannot deny
//! other writers: the final identity check and unlinkat have a small race window.
use std::{
    ffi::CString,
    fs::{File, Metadata, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::Path,
};

pub(crate) fn open(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(io::Error::other("Not a regular file or directory"));
    }
    Ok(file)
}

fn unchanged(expected: &Metadata, actual: &Metadata) -> bool {
    expected.dev() == actual.dev()
        && expected.ino() == actual.ino()
        && expected.is_dir() == actual.is_dir()
        && (expected.is_dir()
            || (expected.len() == actual.len()
                && expected.mtime() == actual.mtime()
                && expected.mtime_nsec() == actual.mtime_nsec()
                && expected.ctime() == actual.ctime()
                && expected.ctime_nsec() == actual.ctime_nsec()))
}

/// Removes only the entry still naming the opened object and its expected version.
/// Nonempty directories are refused by unlinkat, never traversed.
pub(crate) fn remove(path: &Path, file: &File, expected: &Metadata) -> io::Result<()> {
    super::filesystem_safety::ensure_path_no_reparse_points_now(path).map_err(io::Error::other)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = CString::new(
        path.file_name()
            .ok_or_else(|| io::Error::other("No entry name"))?
            .as_bytes(),
    )?;
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(std::fs::canonicalize(parent)?)?;
    // SAFETY: parent is live, name is a single NUL-terminated component; a
    // successful descriptor is transferred exactly once to File.
    let current = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if current < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat just returned an owned descriptor.
    let current = unsafe { File::from_raw_fd(current) };
    if !unchanged(expected, &file.metadata()?) || !unchanged(expected, &current.metadata()?) {
        return Err(io::Error::other("Object changed; retained"));
    }
    let flags = if expected.is_dir() {
        libc::AT_REMOVEDIR
    } else {
        0
    };
    // SAFETY: parent and the single-component name remain live through unlinkat.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_refuses_replaced_modified_and_linked_entries() {
        for change in ["replace", "modify", "link", "parent-link"] {
            let root =
                std::env::temp_dir().join(format!("ftpeach-unlink-{}", uuid::Uuid::new_v4()));
            let parent = root.join("parent");
            std::fs::create_dir_all(&parent).unwrap();
            let path = parent.join("file");
            std::fs::write(&path, b"original").unwrap();
            let file = open(&path).unwrap();
            let expected = file.metadata().unwrap();
            match change {
                "replace" => {
                    std::fs::rename(&path, parent.join("old")).unwrap();
                    std::fs::write(&path, b"replacement").unwrap();
                }
                "modify" => std::fs::write(&path, b"changed content").unwrap(),
                "link" => {
                    std::fs::rename(&path, parent.join("old")).unwrap();
                    std::os::unix::fs::symlink("old", &path).unwrap();
                }
                _ => {
                    std::fs::rename(&parent, root.join("old-parent")).unwrap();
                    std::os::unix::fs::symlink(root.join("old-parent"), &parent).unwrap();
                }
            }
            assert!(remove(&path, &file, &expected).is_err(), "{change}");
            assert!(path.exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn deletion_removes_only_the_verified_file_or_empty_directory() {
        let root = std::env::temp_dir().join(format!("ftpeach-unlink-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("file");
        std::fs::write(&path, b"original").unwrap();
        let folder = open(&root).unwrap();
        let expected = folder.metadata().unwrap();
        assert!(remove(&root, &folder, &expected).is_err());
        let file = open(&path).unwrap();
        remove(&path, &file, &file.metadata().unwrap()).unwrap();
        assert!(!path.exists());
        remove(&root, &folder, &expected).unwrap();
        assert!(!root.exists());
    }
}
