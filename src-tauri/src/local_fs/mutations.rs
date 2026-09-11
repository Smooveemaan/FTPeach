//! Shared exclusion for local mutations, including protocol downloads.
use std::sync::OnceLock;

// Downloads hold a shared guard and reserve their destination separately.
// Renames/removals hold the exclusive guard so ancestors cannot change while
// a download validates, writes and commits its artifact.
pub(crate) fn guard() -> &'static tokio::sync::RwLock<()> {
    static GUARD: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GUARD.get_or_init(|| tokio::sync::RwLock::new(()))
}

/// Validate each destination component without applying Windows naming rules
/// to operations that stay entirely on a remote filesystem.
pub(crate) fn validate_download_name(path: &std::path::Path) -> anyhow::Result<()> {
    for part in path.components() {
        if let std::path::Component::Normal(name) = part {
            let name = name
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid local filename"))?;
            let stem = name.split('.').next().unwrap_or("").to_uppercase();
            let reserved = matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            ) || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
            anyhow::ensure!(
                !reserved
                    && !name.ends_with(['.', ' '])
                    && !name
                        .chars()
                        .any(|c| c.is_control() || "<>:\"|?*".contains(c)),
                "{}: invalid Windows download name",
                path.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
                validate_download_name(&std::path::Path::new("C:/downloads").join(name)).is_err(),
                "{name:?}"
            );
        }
        assert!(validate_download_name(std::path::Path::new("C:/downloads/normal.txt")).is_ok());
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
