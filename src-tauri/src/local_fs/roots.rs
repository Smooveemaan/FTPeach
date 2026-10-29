//! Local navigation roots: drive letters on Windows, home and mount folders on Unix.

use serde::Serialize;
use std::path::PathBuf;

/// A local navigation destination and its menu label.
#[derive(Serialize)]
pub struct Drive {
    path: String,
    label: String,
}

/// The operating system's home directory, if it is an absolute path.
pub(crate) fn home() -> Option<PathBuf> {
    std::env::home_dir().filter(|path| path.is_absolute())
}

#[cfg(windows)]
/// Existing Windows drives, with drive-letter labels.
pub(crate) async fn drives() -> Vec<Drive> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let letter = letter as char;
        let path = format!("{letter}:\\");
        if tokio::fs::metadata(&path).await.is_ok() {
            drives.push(Drive {
                path,
                label: format!("{letter}:"),
            });
        }
    }
    drives
}

#[cfg(unix)]
/// The filesystem root, home, and folders under the platform's mount locations.
pub(crate) async fn drives() -> Vec<Drive> {
    #[cfg(target_os = "macos")]
    let parents = vec![PathBuf::from("/Volumes")];
    #[cfg(not(target_os = "macos"))]
    let parents = {
        let mut parents = vec![PathBuf::from("/mnt")];
        if let Some(user) = std::env::var_os("USER").filter(|user| {
            let mut parts = std::path::Path::new(user).components();
            matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none()
        }) {
            parents.push(PathBuf::from("/media").join(&user));
            parents.push(PathBuf::from("/run/media").join(user));
        }
        parents
    };
    unix_roots(home(), &parents).await
}

#[cfg(unix)]
async fn unix_roots(home: Option<PathBuf>, parents: &[PathBuf]) -> Vec<Drive> {
    let mut paths = vec![PathBuf::from("/")];
    paths.extend(home);
    let mut mounts = Vec::new();
    for parent in parents {
        let Ok(mut entries) = tokio::fs::read_dir(parent).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            // Mounted folders may be symlinks (for example the system volume on macOS).
            if tokio::fs::metadata(entry.path())
                .await
                .is_ok_and(|meta| meta.is_dir())
            {
                mounts.push(entry.path());
            }
        }
    }
    mounts.sort();
    paths.extend(mounts);
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .map(|path| {
            let path = path.to_string_lossy().into_owned();
            Drive {
                label: path.clone(),
                path,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn navigation_roots_include_the_current_filesystem() {
        let roots = drives().await;
        let current = std::env::current_dir().unwrap();
        assert!(roots.iter().any(|drive| current.starts_with(&drive.path)));
        #[cfg(unix)]
        {
            assert_eq!(roots[0].path, "/");
            let home = home().unwrap();
            assert!(
                roots
                    .iter()
                    .any(|drive| std::path::Path::new(&drive.path) == home.as_path())
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn roots_include_home_and_sorted_mount_folders_once() {
        let root = std::env::temp_dir().join(format!("ftpeach-roots-{}", uuid::Uuid::new_v4()));
        let parents: Vec<_> = ["Volumes", "media/user", "run/media/user", "mnt"]
            .iter()
            .map(|name| root.join(name))
            .collect();
        for parent in &parents {
            std::fs::create_dir_all(parent.join("disk")).unwrap();
            std::fs::write(parent.join("file"), b"not a folder").unwrap();
        }
        std::os::unix::fs::symlink(parents[0].join("disk"), parents[0].join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("absent"), parents[0].join("broken")).unwrap();
        let mut inputs = parents.clone();
        inputs.extend([
            parents[0].clone(),
            root.join("absent"),
            parents[0].join("file"),
        ]);
        let home = parents[0].join("disk");
        let mut expected = vec![PathBuf::from("/"), home.clone()];
        let mut mounts: Vec<_> = parents.iter().map(|parent| parent.join("disk")).collect();
        mounts.push(parents[0].join("link"));
        mounts.sort();
        expected.extend(mounts.into_iter().filter(|path| path != &home));
        let roots = unix_roots(Some(home), &inputs).await;
        assert_eq!(
            roots
                .iter()
                .map(|drive| PathBuf::from(&drive.path))
                .collect::<Vec<_>>(),
            expected
        );
        assert!(roots.iter().all(|drive| drive.label == drive.path));
        assert_eq!(unix_roots(None, &[]).await[0].path, "/");
        assert_eq!(unix_roots(Some(PathBuf::from("/")), &[]).await.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
