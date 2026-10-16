use super::DragOutFile;
use crate::local_fs::windows_names::validate_file_name;
use crate::security::connection_guard::is_safe_path_segment;
use crate::transfer::transfer_pool::{TaskFn, TransferPool};
use anyhow::{Result, ensure};
use std::collections::HashSet;

fn validate_name(name: &str) -> Result<()> {
    ensure!(is_safe_path_segment(name), "Unsafe drag entry name");
    Ok(validate_file_name(name)?)
}

fn validate_relative_path(name: &str) -> Result<()> {
    ensure!(
        name.encode_utf16().count() < 260,
        "Drag path exceeds Windows descriptor limit: {name}"
    );
    for segment in name.split('\\') {
        validate_name(segment)?;
    }
    Ok(())
}

/// Enumerated when Explorer requests descriptors, never before DoDragDrop.
/// Keep directory descriptors (including empty ones) and stable content indices.
pub async fn expand(pool: &TransferPool, roots: Vec<DragOutFile>) -> Result<Vec<DragOutFile>> {
    ensure!(
        roots.len() <= 100_000,
        "Drag directory contains too many entries"
    );
    let mut root_names = HashSet::new();
    for root in &roots {
        validate_name(&root.name)?;
        validate_relative_path(&root.name)?;
        ensure!(
            root_names.insert(root.name.to_lowercase()),
            "Duplicate Windows drag path: {}",
            root.name
        );
    }
    if roots.iter().all(|file| !file.is_directory) {
        return Ok(roots);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task: TaskFn = Box::new(move |backend| {
        Box::pin(async move {
            let mut files = roots;
            let mut names = HashSet::new();
            let mut index = 0;
            while index < files.len() {
                let file = files[index].clone();
                validate_relative_path(&file.name)?;
                ensure!(
                    names.insert(file.name.to_lowercase()),
                    "Duplicate Windows drag path: {}",
                    file.name
                );
                ensure!(
                    files.len() <= 100_000,
                    "Drag directory contains too many entries"
                );
                if file.is_directory {
                    for child in backend.list(&file.remote_path).await? {
                        validate_name(&child.name)?;
                        let name = format!("{}\\{}", file.name, child.name);
                        validate_relative_path(&name)?;
                        files.push(DragOutFile {
                            remote_path: format!(
                                "{}/{}",
                                file.remote_path.trim_end_matches('/'),
                                child.name
                            ),
                            name,
                            size: if child.is_directory {
                                None
                            } else {
                                Some(child.size)
                            },
                            is_directory: child.is_directory,
                        });
                    }
                }
                index += 1;
            }
            let _ = tx.send(files);
            Ok(())
        })
    });
    pool.run(uuid::Uuid::new_v4().to_string(), task).await?;
    Ok(rx.await?)
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod manifest_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_relative_windows_paths_without_truncation() {
        assert!(validate_relative_path("folder\\nested\\file.txt").is_ok());
        for name in [
            "..\\escape",
            "\\absolute",
            "folder\\CON",
            "folder\\bad:stream",
            "folder\\trailing.",
            // One letter and a colon read as a drive when the name is parsed
            // as a path, which hid the stream separator from the check.
            "a:b",
            "folder\\x:y",
        ] {
            assert!(validate_relative_path(name).is_err(), "{name}");
        }
        assert!(validate_relative_path(&"a".repeat(260)).is_err());
        assert!(validate_relative_path(&"😀".repeat(130)).is_err());
    }
}
