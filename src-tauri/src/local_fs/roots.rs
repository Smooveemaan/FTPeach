//! Local navigation roots: drive letters on Windows, filesystem root and mount folders on Unix.

use serde::Serialize;
use std::path::PathBuf;

/// A local navigation destination and its menu label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
/// The filesystem root and folders under the platform's mount locations.
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
    unix_roots(&parents).await
}

#[cfg(unix)]
async fn unix_roots(parents: &[PathBuf]) -> Vec<Drive> {
    #[cfg(target_os = "macos")]
    let mut root_label = "Macintosh HD".to_string();
    #[cfg(not(target_os = "macos"))]
    let mut root_label = "/".to_string();

    let mut mounts: Vec<(PathBuf, String)> = Vec::new();
    for parent in parents {
        let Ok(mut entries) = tokio::fs::read_dir(parent).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            // On macOS, the system root volume is typically symlinked in /Volumes (e.g. Macintosh HD -> /).
            if tokio::fs::read_link(&path)
                .await
                .is_ok_and(|target| target == std::path::Path::new("/"))
            {
                if let Some(name) = entry.file_name().to_str() {
                    root_label = name.to_string();
                }
                // Skip adding this symlink as a separate mount since / is already the root.
                continue;
            }

            // Mounted folders may be symlinks (for example external volumes).
            if tokio::fs::metadata(&path)
                .await
                .is_ok_and(|meta| meta.is_dir())
            {
                let label = entry.file_name().to_string_lossy().into_owned();
                mounts.push((path, label));
            }
        }
    }
    mounts.sort_by(|a, b| a.0.cmp(&b.0));

    let mut drives = Vec::new();
    let mut seen = std::collections::HashSet::new();

    seen.insert(PathBuf::from("/"));
    drives.push(Drive {
        path: "/".to_string(),
        label: root_label,
    });

    for (path, label) in mounts {
        if seen.insert(path.clone()) {
            drives.push(Drive {
                path: path.to_string_lossy().into_owned(),
                label,
            });
        }
    }

    drives
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
            #[cfg(target_os = "macos")]
            assert_eq!(roots[0].label, "Macintosh HD");
            #[cfg(not(target_os = "macos"))]
            assert_eq!(roots[0].label, "/");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn roots_include_sorted_mount_folders_once() {
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
        let mut expected = vec![PathBuf::from("/")];
        let mut mounts: Vec<_> = parents.iter().map(|parent| parent.join("disk")).collect();
        mounts.push(parents[0].join("link"));
        mounts.sort();
        expected.extend(mounts);
        let roots = unix_roots(&inputs).await;
        assert_eq!(
            roots
                .iter()
                .map(|drive| PathBuf::from(&drive.path))
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(roots[0].path, "/");
        #[cfg(target_os = "macos")]
        assert_eq!(roots[0].label, "Macintosh HD");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(roots[0].label, "/");

        for drive in &roots[1..] {
            let file_name = std::path::Path::new(&drive.path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap();
            assert_eq!(drive.label, file_name);
        }
        assert_eq!(unix_roots(&[]).await[0].path, "/");
        assert_eq!(unix_roots(&[]).await.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn roots_detect_symlink_to_root_as_system_volume() {
        let root = std::env::temp_dir().join(format!("ftpeach-roots-{}", uuid::Uuid::new_v4()));
        let volumes = root.join("Volumes");
        std::fs::create_dir_all(&volumes).unwrap();
        std::os::unix::fs::symlink("/", volumes.join("Macintosh HD")).unwrap();
        std::fs::create_dir_all(volumes.join("External")).unwrap();

        let roots = unix_roots(&[volumes]).await;
        assert_eq!(roots[0].path, "/");
        assert_eq!(roots[0].label, "Macintosh HD");
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[1].label, "External");
        assert_eq!(
            roots[1].path,
            root.join("Volumes/External").to_string_lossy()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
