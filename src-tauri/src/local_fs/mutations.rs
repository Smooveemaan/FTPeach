//! Shared exclusion for local mutations, including protocol downloads.
use std::sync::OnceLock;

// Downloads hold a shared guard and reserve their destination separately.
// Renames/removals hold the exclusive guard so ancestors cannot change while
// a download validates, writes and commits its artifact.
pub(crate) fn guard() -> &'static tokio::sync::RwLock<()> {
    static GUARD: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GUARD.get_or_init(|| tokio::sync::RwLock::new(()))
}

/// Apply the host filesystem naming rules to local download destinations.
pub(crate) fn validate_download_name(path: &std::path::Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    for part in path.components() {
        if let std::path::Component::Normal(name) = part {
            let name = name
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid local filename"))?;
            super::windows_names::validate_file_name(name)?;
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn rejects_windows_devices_ads_controls_and_lossy_names() {
        for name in [
            "CON",
            "NUL.txt",
            "name:stream",
            "name\u{0}",
            "name\n",
            "name.",
            "name ",
            "COM1.log",
            "LPT9",
        ] {
            assert!(
                validate_download_name(&std::path::Path::new("/downloads").join(name)).is_err(),
                "{name:?}"
            );
        }
        assert!(validate_download_name(std::path::Path::new("/downloads/normal.txt")).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn a_refused_download_name_reports_the_name() {
        let error = validate_download_name(std::path::Path::new("/downloads/CON.txt")).unwrap_err();
        let error = crate::ipc::CommandError::from_anyhow(&error);
        assert_eq!(error.code, crate::ipc::ErrorCode::InvalidFileName);
        assert_eq!(error.message, "CON.txt");
    }
    #[cfg(unix)]
    #[test]
    fn unix_download_names_preserve_characters_allowed_by_the_filesystem() {
        for name in [
            "CON",
            "name:stream",
            "name.",
            "name ",
            "name\n",
            "back\\slash",
        ] {
            assert!(validate_download_name(&std::path::Path::new("/downloads").join(name)).is_ok());
        }
    }
    #[tokio::test]
    async fn mutations_wait_until_the_download_releases_its_guard() {
        // A queued writer from another test prevents new readers on Tokio's
        // fair lock. Keep this lock-semantics assertion isolated from global IO.
        let lock = tokio::sync::RwLock::new(());
        let download = lock.read().await;
        assert!(lock.try_write().is_err());
        let second_download = lock.try_read().expect("independent downloads can overlap");
        drop(second_download);
        drop(download);
        let _next = tokio::time::timeout(std::time::Duration::from_secs(5), lock.write())
            .await
            .unwrap();
    }
}
