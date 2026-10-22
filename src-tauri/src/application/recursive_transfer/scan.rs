//! Cooperative scanning builds a bounded manifest before any mutation.
use super::io::listing;
use super::manifest::{Entry, MAX_DEPTH, Manifest};
use super::model::{Endpoint, check_cancel};
use crate::ipc::CommandError;
use crate::session::Sessions;
use anyhow::Result;
use tokio_util::sync::CancellationToken;

pub(super) async fn scan(
    sessions: &Sessions,
    source: &Endpoint,
    skip_artifacts: bool,
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
            if parent.split('/').filter(|p| !p.is_empty()).count() > MAX_DEPTH {
                return Err(CommandError::at_path(
                    anyhow::anyhow!("recursive depth exceeds budget"),
                    source.path(&parent),
                ));
            }
            for child in listing(sessions, source, &parent, token)
                .await
                .map_err(|error| CommandError::at_path(error, source.path(&parent)))?
            {
                check_cancel(token)?;
                // Another transfer's working files, such as a paused upload's
                // staging, are not part of the folder and are not copied with
                // it. A move takes them along: the folder must end up empty.
                if skip_artifacts
                    && !child.is_directory
                    && crate::protocol::transfer_file::is_artifact_name(&child.name)
                {
                    continue;
                }
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
