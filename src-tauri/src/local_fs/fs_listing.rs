//! Local directory listing — the one FTPeach filesystem operation with no
//! destructive-safety invariants to enforce, just untrusted-name filtering
//! (see is_safe_path_segment) and per-platform hidden-file detection.

use serde::Serialize;
use std::path::Path;
use std::time::SystemTime;

fn is_safe_path_segment(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['\\', '/'])
}

fn iso(t: std::io::Result<SystemTime>) -> Option<String> {
    let t = t.ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsEntry {
    pub(crate) name: String,
    pub(crate) is_directory: bool,
    pub(crate) is_hidden: bool,
    pub(crate) size: u64,
    pub(crate) modified_at: Option<String>,
    pub(crate) created_at: Option<String>,
}

pub(crate) async fn list_directory(target: &Path) -> std::io::Result<Vec<FsEntry>> {
    let mut read_dir = tokio::fs::read_dir(target).await?;
    let mut entries = Vec::new();
    loop {
        let next = match read_dir.next_entry().await? {
            Some(entry) => entry,
            None => break,
        };
        let name = next.file_name().to_string_lossy().into_owned();
        if !is_safe_path_segment(&name) {
            continue;
        }
        let meta = next.metadata().await.ok();
        let is_directory = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = meta.as_ref().and_then(|m| iso(m.modified()));
        let created_at = meta.as_ref().and_then(|m| iso(m.created()));
        #[cfg(windows)]
        let is_hidden = {
            use std::os::windows::fs::MetadataExt;
            meta.as_ref()
                .is_some_and(|m| m.file_attributes() & 0x2 != 0)
                || name.starts_with('.')
        };
        #[cfg(not(windows))]
        let is_hidden = name.starts_with('.');
        entries.push(FsEntry {
            name,
            is_directory,
            is_hidden,
            size,
            modified_at,
            created_at,
        });
    }
    Ok(entries)
}
