//! Programs the user chose for Open with. Settings only name a program; this
//! list decides whether naming it still needs a security confirmation. No
//! renderer command writes it: a program joins only after a native file
//! dialog picked it or the user approved it in a confirmation window.
use super::Store;
use anyhow::Result;
use std::path::{Path, PathBuf};

/// Bounds the file a long-lived install accumulates; the oldest entries go.
const MAX_TRUSTED_APPLICATIONS: usize = 256;

fn application_key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    return value.to_lowercase();
    #[cfg(not(windows))]
    value
}

impl Store {
    fn trusted_applications_file(&self) -> PathBuf {
        self.dir.join("trusted_applications.json")
    }

    /// `path` must already be canonical, as `ApprovedLocalPaths` returns it.
    pub async fn is_trusted_application(&self, path: &Path) -> bool {
        let key = application_key(path);
        self.read_json::<Vec<String>>(&self.trusted_applications_file(), Vec::new())
            .await
            .contains(&key)
    }

    /// `path` must already be canonical, as `ApprovedLocalPaths` returns it.
    pub async fn trust_application(&self, path: &Path) -> Result<()> {
        let file = self.trusted_applications_file();
        let lock = self.lock_for(&file).await;
        let _guard = lock.lock().await;
        let key = application_key(path);
        let mut trusted = self.read_json::<Vec<String>>(&file, Vec::new()).await;
        trusted.retain(|entry| entry != &key);
        trusted.push(key);
        let excess = trusted.len().saturating_sub(MAX_TRUSTED_APPLICATIONS);
        trusted.drain(..excess);
        self.write_json(&file, &trusted).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ftpeach-trusted-{}", uuid::Uuid::new_v4()));
        (Store::new_at(dir.clone()), dir)
    }

    #[tokio::test]
    async fn only_trusted_programs_are_reported_and_the_list_stays_bounded() {
        let (store, dir) = store();
        let editor = PathBuf::from(r"C:\Tools\Editor.exe");
        assert!(!store.is_trusted_application(&editor).await);
        store.trust_application(&editor).await.unwrap();
        assert!(store.is_trusted_application(&editor).await);
        assert!(
            !store
                .is_trusted_application(Path::new(r"C:\Tools\Other.exe"))
                .await
        );

        for index in 0..MAX_TRUSTED_APPLICATIONS {
            store
                .trust_application(&PathBuf::from(format!(r"C:\Tools\app{index}.exe")))
                .await
                .unwrap();
        }
        assert!(!store.is_trusted_application(&editor).await);
        assert!(
            store
                .is_trusted_application(Path::new(r"C:\Tools\app255.exe"))
                .await
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
