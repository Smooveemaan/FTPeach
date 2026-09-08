//! Cooperative scanning builds a bounded manifest before any mutation.
use super::io::listing;
use super::manifest::{Entry, MAX_DEPTH, Manifest};
use super::model::{Endpoint, check_cancel};
use crate::session::Sessions;
use anyhow::{Context, Result};
use tokio_util::sync::CancellationToken;

pub(super) async fn scan(
    sessions: &Sessions,
    source: &Endpoint,
    token: &CancellationToken,
) -> Result<Manifest> {
    let mut manifest = Manifest::default();
    manifest.push(Entry {
        relative: String::new(),
        directory: true,
        size: 0,
        modified: None,
    })?;
    let mut index = 0;
    while index < manifest.entries.len() {
        check_cancel(token)?;
        let entry = &manifest.entries[index];
        if entry.directory {
            let parent = entry.relative.clone();
            anyhow::ensure!(
                parent.split('/').filter(|p| !p.is_empty()).count() <= MAX_DEPTH,
                "{}: recursive depth exceeds budget",
                source.path(&parent)
            );
            for child in listing(sessions, source, &parent, token)
                .await
                .with_context(|| source.path(&parent))?
            {
                check_cancel(token)?;
                anyhow::ensure!(
                    crate::security::connection_guard::is_safe_path_segment(&child.name),
                    "Unsafe recursive entry name"
                );
                let relative = if parent.is_empty() {
                    child.name
                } else {
                    format!("{parent}/{}", child.name)
                };
                manifest.push(Entry {
                    relative,
                    directory: child.is_directory,
                    size: if child.is_directory { 0 } else { child.size },
                    modified: if child.is_directory {
                        None
                    } else {
                        child.modified_at
                    },
                })?;
            }
        }
        index += 1;
        if index % 128 == 0 {
            tokio::task::yield_now().await;
        }
    }
    Ok(manifest)
}
