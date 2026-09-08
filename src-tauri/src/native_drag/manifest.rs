use super::DragOutFile;
use crate::local_fs::mutations::validate_download_name;
use crate::security::connection_guard::is_safe_path_segment;
use crate::transfer::transfer_pool::{TaskFn, TransferPool};
use anyhow::{Result, ensure};
use std::collections::HashSet;

fn validate_name(name: &str) -> Result<()> {
    ensure!(is_safe_path_segment(name), "Unsafe drag entry name");
    validate_download_name(std::path::Path::new(name))
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
pub(super) async fn expand(
    pool: &TransferPool,
    roots: Vec<DragOutFile>,
) -> Result<Vec<DragOutFile>> {
    for root in &roots {
        validate_name(&root.name)?;
    }
    if roots.iter().all(|file| !file.is_directory) {
        for root in &roots {
            validate_relative_path(&root.name)?;
        }
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
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires the Docker WebDAV test server on port 6065"]
    async fn docker_folder_manifest_preserves_nested_and_empty_directories() {
        use crate::protocol::{ProtocolBackend, config::ConnectionConfig, webdav::WebDavBackend};
        use crate::transfer::transfer_pool::{BackendFactory, BoxBackend, PoolSize};
        use std::sync::Arc;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = ConnectionConfig::from_json_map(
            serde_json::json!({
                "protocol": "webdav", "webdavUrl": "http://127.0.0.1:6065",
                "user": "testuser", "password": "testpass"
            })
            .as_object()
            .unwrap(),
        )
        .unwrap();
        let mut backend = WebDavBackend::new();
        backend.connect(&config).await.unwrap();
        let root = format!("/drag-test-{}", uuid::Uuid::new_v4());
        backend.mkdir(&root).await.unwrap();
        backend.mkdir(&format!("{root}/empty")).await.unwrap();
        backend.mkdir(&format!("{root}/nested")).await.unwrap();
        backend
            .create_file(&format!("{root}/nested/file.txt"))
            .await
            .unwrap();
        let factory: BackendFactory = Arc::new(move || {
            let config = config.clone();
            Box::pin(async move {
                let mut backend = WebDavBackend::new();
                backend.connect(&config).await?;
                Ok(Box::new(backend) as BoxBackend)
            })
        });
        let pool = TransferPool::new(factory, PoolSize::Fixed(1));
        let result = expand(
            &pool,
            vec![DragOutFile {
                remote_path: root.clone(),
                name: "folder".into(),
                size: None,
                is_directory: true,
            }],
        )
        .await;
        backend.remove(&root, true).await.unwrap();
        backend.disconnect().await.unwrap();
        let files = result.unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].name, "folder");
        assert!(
            files
                .iter()
                .any(|f| f.name == "folder\\empty" && f.is_directory)
        );
        assert!(
            files
                .iter()
                .any(|f| f.name == "folder\\nested" && f.is_directory)
        );
        assert!(files.iter().any(|f| f.name == "folder\\nested\\file.txt"
            && f.remote_path == format!("{root}/nested/file.txt")
            && !f.is_directory));
    }

    #[test]
    fn validates_relative_windows_paths_without_truncation() {
        assert!(validate_relative_path("folder\\nested\\file.txt").is_ok());
        for name in [
            "..\\escape",
            "\\absolute",
            "folder\\CON",
            "folder\\bad:stream",
            "folder\\trailing.",
        ] {
            assert!(validate_relative_path(name).is_err(), "{name}");
        }
        assert!(validate_relative_path(&"a".repeat(260)).is_err());
        assert!(validate_relative_path(&"😀".repeat(130)).is_err());
    }
}
