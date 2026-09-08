//! Permanent (non-recycle-bin) local delete — the guarded recursive removal
//! that re-checks the no-reparse-point invariant at every level while
//! walking the tree, not only once up front. See filesystem_safety.rs for
//! the shared canonical-path/protected-path/reparse-point validation this
//! builds on, and recycle_bin.rs for the Windows recycle-bin alternative
//! `fs_delete` (in commands/fs.rs) dispatches to instead on that platform.

use crate::ipc::{OkResult, err, ok};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, is_reparse_point, validated_delete_target,
};
use std::path::Path;

pub(crate) async fn remove_tree_without_reparse_points(root: &Path) -> std::io::Result<()> {
    let mut pending = vec![(root.to_path_buf(), false)];
    while let Some((path, children_visited)) = pending.pop() {
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if is_reparse_point(&metadata) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Refusing to delete a symbolic link, junction, or reparse point",
            ));
        }
        if !metadata.is_dir() {
            tokio::fs::remove_file(&path).await?;
            continue;
        }
        if children_visited {
            // Never recurse through an OS helper. Removing an empty directory
            // after a fresh metadata check cannot cross a reparse boundary.
            tokio::fs::remove_dir(&path).await?;
            continue;
        }

        pending.push((path.clone(), true));
        let mut entries = tokio::fs::read_dir(&path).await?;
        while let Some(entry) = entries.next_entry().await? {
            pending.push((entry.path(), false));
        }
    }
    Ok(())
}

fn is_busy(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(32) | Some(33)) // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION
}

pub(crate) async fn fs_delete_permanently(local_path: String) -> OkResult {
    for attempt in 0..2 {
        let target = match validated_delete_target(Path::new(&local_path)).await {
            Ok(Some(target)) => target,
            Ok(None) => return ok(),
            Err(error) => return err(error),
        };
        if let Err(error) = ensure_path_no_reparse_points_now(&target.0) {
            return err(error);
        }
        let result = if target.1 {
            remove_tree_without_reparse_points(&target.0).await
        } else {
            match ensure_path_no_reparse_points_now(&target.0) {
                Ok(()) => tokio::fs::remove_file(&target.0).await,
                Err(error) => Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    error.to_string(),
                )),
            }
        };
        match result {
            Ok(()) => return ok(),
            Err(e) if attempt == 0 && is_busy(&e) => {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ok(),
            Err(e) => return err(e),
        }
    }
    ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn guarded_recursive_delete_removes_an_ordinary_tree() {
        let root = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let nested = root.join("a").join("b");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        tokio::fs::write(nested.join("file.txt"), b"test")
            .await
            .unwrap();

        remove_tree_without_reparse_points(&root).await.unwrap();

        assert!(!root.exists());
    }
}
