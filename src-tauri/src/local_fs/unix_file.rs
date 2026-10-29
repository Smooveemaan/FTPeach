//! Unix no-replace renames and verified directory-entry removal. Unix cannot
//! deny writers: the final identity check and unlinkat have a small race window.
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

/// Renames files and directories without replacing even an empty destination.
/// Filesystems lacking exclusive rename may use hard links for regular files.
pub(crate) fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let from = CString::new(source.as_os_str().as_bytes())?;
    let to = CString::new(destination.as_os_str().as_bytes())?;
    #[cfg(target_os = "linux")]
    // SAFETY: both paths are NUL-terminated and live through the call.
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    // SAFETY: both paths are NUL-terminated and live through the call.
    let status = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let result = if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let result = {
        let _ = (from, to);
        Err(io::Error::from_raw_os_error(libc::ENOSYS))
    };
    finish_rename(source, destination, result)
}

fn finish_rename(source: &Path, destination: &Path, result: io::Result<()>) -> io::Result<()> {
    match result {
        Ok(()) => return Ok(()),
        Err(error)
            if !error.raw_os_error().is_some_and(|code| {
                [libc::ENOSYS, libc::EINVAL, libc::ENOTSUP, libc::EOPNOTSUPP].contains(&code)
            }) =>
        {
            return Err(error);
        }
        Err(_) => {}
    }
    let file = open(source)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Exclusive directory rename is unavailable",
        ));
    }
    std::fs::hard_link(source, destination)?;
    // Linking changes ctime; capture the version after adding the new name.
    remove(source, &file, &file.metadata()?)
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
    fn concurrent_no_replace_renames_publish_only_one_source() {
        let root = std::env::temp_dir().join(format!("ftpeach-rename-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let sources = [root.join("a"), root.join("b")];
        for (index, source) in sources.iter().enumerate() {
            std::fs::write(source, [index as u8]).unwrap();
        }
        let target = root.join("target");
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = sources
                .iter()
                .map(|source| {
                    let (target, barrier) = (&target, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        rename_no_replace(source, target)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let winner = std::fs::read(&target).unwrap()[0] as usize;
        assert!(!sources[winner].exists());
        assert_eq!(
            std::fs::read(&sources[1 - winner]).unwrap(),
            [(1 - winner) as u8]
        );
        assert_eq!(
            results[1 - winner].as_ref().unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        std::fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink("missing", &target).unwrap();
        assert_eq!(
            rename_no_replace(&sources[1 - winner], &target)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read_link(&target).unwrap(), Path::new("missing"));
        assert!(sources[1 - winner].exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hard_link_fallback_is_only_used_for_unsupported_exclusive_rename() {
        let root = std::env::temp_dir().join(format!("ftpeach-rename-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        std::fs::write(&source, b"source").unwrap();
        for code in [
            libc::EEXIST,
            libc::EACCES,
            libc::EPERM,
            libc::EXDEV,
            libc::ENOSPC,
            libc::ENOENT,
        ] {
            let error = finish_rename(&source, &target, Err(io::Error::from_raw_os_error(code)))
                .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(code));
            assert!(source.exists());
            assert!(!target.exists());
        }
        for code in [libc::ENOSYS, libc::EINVAL, libc::ENOTSUP, libc::EOPNOTSUPP] {
            std::fs::write(&target, b"external").unwrap();
            assert_eq!(
                finish_rename(&source, &target, Err(io::Error::from_raw_os_error(code)))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::AlreadyExists
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"external");
            std::fs::remove_file(&target).unwrap();
            finish_rename(&source, &target, Err(io::Error::from_raw_os_error(code))).unwrap();
            assert!(!source.exists());
            assert_eq!(std::fs::read(&target).unwrap(), b"source");
            std::fs::rename(&target, &source).unwrap();
        }
        std::fs::create_dir(root.join("folder")).unwrap();
        assert!(
            finish_rename(
                &root.join("folder"),
                &target,
                Err(io::Error::from_raw_os_error(libc::ENOSYS))
            )
            .is_err()
        );
        assert!(root.join("folder").is_dir());
        assert!(!target.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

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
