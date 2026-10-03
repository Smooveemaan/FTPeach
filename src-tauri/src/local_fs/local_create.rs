//! Creating an empty folder or file on this computer. The IPC commands only
//! authorize and translate; the order of checks and what holds while the
//! entry is made live here.

use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validate_write_destination,
};
use crate::local_fs::target_reservation::Reservation;
use anyhow::Result;
use std::path::{Path, PathBuf};

/// A path about to receive a new entry. While this lives, no other operation
/// in this process may write the same path, and no local move, rename or
/// delete runs; the checks it passed therefore still hold when the entry is
/// made.
pub(crate) struct NewEntry {
    path: PathBuf,
    _lease: Reservation,
    _mutation: tokio::sync::RwLockReadGuard<'static, ()>,
}

impl NewEntry {
    pub(crate) async fn reserve(path: &Path) -> Result<Self> {
        // Busy is reported before waiting for other mutations to finish.
        let lease = Reservation::acquire(&path.to_string_lossy())?;
        // Shared, as a download holds it: making an entry moves and removes
        // nothing, so it need not wait for downloads, only keep moves out.
        let mutation = crate::local_fs::mutations::guard().read().await;
        let entry = Self {
            path: path.to_path_buf(),
            _lease: lease,
            _mutation: mutation,
        };
        entry.check().await?;
        Ok(entry)
    }

    /// A protected location or a reparse point anywhere on the path is
    /// refused, before creating and again after.
    async fn check(&self) -> Result<()> {
        validate_write_destination(&self.path).await?;
        ensure_path_no_reparse_points_now(&self.path)
    }
}

/// Creates `path` and any missing parents.
pub(crate) async fn create_dir(path: &Path) -> Result<()> {
    let entry = NewEntry::reserve(path).await?;
    tokio::fs::create_dir_all(&entry.path).await?;
    entry.check().await
}

/// Creates an empty file at `path`, never replacing one that is there.
pub(crate) async fn create_file(path: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let entry = NewEntry::reserve(path).await?;
    let mut file = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&entry.path)
        .await
    {
        Ok(file) => file,
        // Windows answers "access denied" when a folder has the name; the
        // name is taken all the same.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists || entry.path.is_dir() => {
            return Err(CommandError::new(ErrorCode::AlreadyExists, "File already exists").into());
        }
        Err(error) => return Err(error.into()),
    };
    let _ = file.flush().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ftpeach-create-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn creates_folders_with_parents_and_files_without_replacing() {
        let root = scratch();
        create_dir(&root.join("a/b")).await.unwrap();
        assert!(root.join("a/b").is_dir());
        // An existing folder is already what was asked for.
        create_dir(&root.join("a/b")).await.unwrap();

        let file = root.join("a/new.txt");
        create_file(&file).await.unwrap();
        std::fs::write(&file, b"keep").unwrap();
        let error = create_file(&file).await.unwrap_err();
        assert_eq!(
            CommandError::from_anyhow(&error).code,
            ErrorCode::AlreadyExists
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// One name per folder: a file cannot take a folder's name, nor a folder
    /// a file's, and the refusal says the name is taken.
    #[tokio::test]
    async fn a_name_taken_by_the_other_kind_of_entry_is_reported_as_taken() {
        let root = scratch();
        std::fs::create_dir(root.join("folder")).unwrap();
        std::fs::write(root.join("file"), b"keep").unwrap();
        for error in [
            create_file(&root.join("folder")).await.unwrap_err(),
            create_dir(&root.join("file")).await.unwrap_err(),
        ] {
            assert_eq!(
                CommandError::from_anyhow(&error).code,
                ErrorCode::AlreadyExists,
                "{error:#}"
            );
        }
        assert!(root.join("folder").is_dir());
        assert_eq!(std::fs::read(root.join("file")).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_path_another_operation_writes_is_busy_and_left_alone() {
        let root = scratch();
        let file = root.join("held.txt");
        let _held = Reservation::acquire(&file.to_string_lossy()).unwrap();
        let error = create_file(&file).await.unwrap_err();
        assert_eq!(CommandError::from_anyhow(&error).code, ErrorCode::Busy);
        assert!(!file.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn moves_are_kept_out_until_the_entry_exists() {
        let root = scratch();
        let entry = NewEntry::reserve(&root.join("x")).await.unwrap();
        assert!(crate::local_fs::mutations::guard().try_write().is_err());
        drop(entry);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_junction_on_the_path_is_refused_before_anything_is_created() {
        let root = scratch();
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        let junction = root.join("junction");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(create_dir(&junction.join("inside")).await.is_err());
        assert!(create_file(&junction.join("inside.txt")).await.is_err());
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
