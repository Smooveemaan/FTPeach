//! Local and protocol adapters used by recursive phases.
use super::model::{Endpoint, Intent, check_cancel};
use crate::application::transfer_service;
use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::target_reservation::{Access, Reservation};
use crate::local_fs::{filesystem_safety as safety, mutations, staged_copy};
use crate::protocol::EntryInfo;
use crate::session::Sessions;
use crate::transfer::progress::ProgressEmitter;
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// How long a stopped scan waits for its remote listing to finish before
/// giving up on the browse connection.
const STOPPED_LISTING_GRACE: Duration = Duration::from_secs(2);

pub(super) async fn listing(
    sessions: &Sessions,
    endpoint: &Endpoint,
    relative: &str,
    token: &CancellationToken,
) -> Result<Vec<EntryInfo>> {
    check_cancel(token)?;
    let path = endpoint.path(relative);
    match endpoint {
        Endpoint::Local { .. } => {
            safety::validate_read_source(Path::new(&path)).await?;
            safety::ensure_path_no_reparse_points_now(Path::new(&path))?;
            let mut directory = tokio::fs::read_dir(&path).await?;
            let mut entries = Vec::new();
            while let Some(child) = directory.next_entry().await? {
                check_cancel(token)?;
                safety::ensure_path_no_reparse_points_now(&child.path())?;
                let metadata = child.metadata().await?;
                let name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("Non-Unicode filename"))?;
                anyhow::ensure!(
                    entries.len() < super::manifest::MAX_ENTRIES,
                    "Directory exceeds entry budget"
                );
                entries.push(EntryInfo {
                    name,
                    is_directory: metadata.is_dir(),
                    size: metadata.len(),
                    modified_at: metadata
                        .modified()
                        .ok()
                        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()),
                    permissions: None,
                    owner: None,
                    group: None,
                });
            }
            Ok(entries)
        }
        Endpoint::Remote { connection_id, .. } => {
            crate::protocol::validate_remote_path(&path)?;
            let slot = sessions.lookup_slot(connection_id);
            let mut guard = tokio::select! { guard = slot.lock() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
            let session = guard.as_mut().context("Remote session unavailable")?;
            let timeout = Duration::from_millis(if session.browse_timeout_ms == 0 {
                60_000
            } else {
                session.browse_timeout_ms
            });
            // The browse connection is the pane's own, so a stop lets a listing
            // already under way finish and drops its entries. Cut off mid-reply,
            // an FTP control connection is unusable, and the pane would report
            // the connection lost after a stop the user asked for.
            let (result, reusable) = {
                let listing =
                    tokio::time::timeout(timeout, session.browse_client.list_for_recursive(&path));
                tokio::pin!(listing);
                // A stop that has arrived wins over a listing that just finished.
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        let settled = tokio::time::timeout(STOPPED_LISTING_GRACE, &mut listing).await;
                        (
                            Err(CommandError::new(ErrorCode::Cancelled, "Recursive scan cancelled").into()),
                            matches!(settled, Ok(Ok(_))),
                        )
                    }
                    // Only a listing cut off mid-reply spoils the connection. A
                    // complete refusal, such as a folder that is gone, leaves it
                    // as the backend left it; dropped, the pane lost its
                    // connection over a folder someone deleted.
                    result = &mut listing => match result {
                        Ok(result) => (result, true),
                        Err(elapsed) => (Err(elapsed.into()), false),
                    }
                }
            };
            if !reusable {
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    session.browse_client.disconnect(),
                )
                .await;
            }
            let entries = result?;
            crate::protocol::validate_listing(&entries)?;
            Ok(entries)
        }
    }
}

/// Leases a walk's root on `endpoint`: a place on the local disk, or on the
/// server a remote endpoint's session is connected to.
pub(super) async fn reserve(
    sessions: &Sessions,
    endpoint: &Endpoint,
    access: Access,
) -> Result<Reservation> {
    let path = endpoint.path("");
    match endpoint {
        Endpoint::Local { .. } => Reservation::acquire_local(&path, access),
        Endpoint::Remote { connection_id, .. } => {
            Reservation::acquire_remote(sessions, connection_id, &path, access).await
        }
    }
}

/// Runs `task` on a transfer connection. It waits there for a connection and a
/// free transfer slot; `on_dispatch` is called once it has both.
pub(super) async fn remote_task(
    sessions: &Sessions,
    connection: &str,
    id: String,
    token: &CancellationToken,
    task: crate::transfer::transfer_pool::TaskFn,
    on_dispatch: impl FnOnce() + Send + 'static,
) -> Result<()> {
    let pool = sessions
        .pool_for(connection)
        .await
        .context("Remote session unavailable")?;
    let work = pool.run_notified(id.clone(), task, on_dispatch);
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        _ = token.cancelled() => { pool.cancel(&id); let _ = work.await; check_cancel(token) }
    }
}

/// Makes one target directory, answering whether this call created it rather
/// than finding it already there. On a server it waits its turn like a
/// transfer, and `on_dispatch` is called when that turn comes. A parent the
/// caller has just made itself is not listed first: nothing can be in it yet.
pub(super) async fn mkdir(
    sessions: &Sessions,
    target: &Endpoint,
    relative: &str,
    fresh_parent: bool,
    token: &CancellationToken,
    on_dispatch: impl FnOnce() + Send + 'static,
) -> Result<bool> {
    let path = target.path(relative);
    match target {
        Endpoint::Local { .. } => {
            // Shared, as a download holds it: making a folder moves and removes
            // nothing, so only moves and removals need keeping out.
            let _guard = tokio::select! { guard = mutations::guard().read() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
            safety::validate_write_destination(Path::new(&path)).await?;
            safety::ensure_path_no_reparse_points_now(Path::new(&path))?;
            let existed = tokio::fs::symlink_metadata(&path).await.is_ok();
            tokio::fs::create_dir_all(&path).await?;
            safety::ensure_path_no_reparse_points_now(Path::new(&path))?;
            Ok(!existed)
        }
        Endpoint::Remote { connection_id, .. } => {
            crate::protocol::validate_remote_path(&path)?;
            let created = Arc::new(AtomicBool::new(false));
            let created_by_task = created.clone();
            remote_task(
                sessions,
                connection_id,
                uuid::Uuid::new_v4().to_string(),
                token,
                Box::new(move |backend| {
                    Box::pin(async move {
                        tokio::time::timeout(Duration::from_secs(60), async {
                            let trimmed = path.trim_end_matches('/');
                            if trimmed.is_empty() {
                                return Ok(());
                            }
                            let (parent, name) = trimmed.rsplit_once('/').unwrap_or(("/", trimmed));
                            if !fresh_parent {
                                let entries = backend
                                    .list(if parent.is_empty() { "/" } else { parent })
                                    .await?;
                                crate::protocol::validate_listing(&entries)?;
                                if let Some(existing) =
                                    entries.iter().find(|entry| entry.name == name)
                                {
                                    anyhow::ensure!(
                                        existing.is_directory,
                                        "Destination directory is occupied by a file: {path}"
                                    );
                                    return Ok(());
                                }
                            }
                            let made = backend.mkdir(&path).await;
                            created_by_task.store(made.is_ok(), Ordering::SeqCst);
                            made
                        })
                        .await??;
                        Ok(())
                    })
                }),
                on_dispatch,
            )
            .await?;
            Ok(created.load(Ordering::SeqCst))
        }
    }
}

async fn copy_local(
    source: &str,
    target: &str,
    overwrite: bool,
    token: &CancellationToken,
) -> Result<()> {
    // Shared, as a download holds it: the copy only writes its own new file.
    let _guard = tokio::select! { guard = mutations::guard().read() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
    let source = Path::new(source);
    let target = Path::new(target);
    safety::validate_copy_relationship(source, target)?;
    safety::validate_read_source(source).await?;
    safety::validate_write_destination(target).await?;
    safety::ensure_path_no_reparse_points_now(source)?;
    safety::ensure_path_no_reparse_points_now(target)?;
    staged_copy::copy_file(source, target, overwrite, token)
        .await
        .or_else(|error| {
            check_cancel(token)?;
            Err(error)
        })
}

/// Copies one file using the explicit overwrite policy. `resume` carries a
/// download on from the partial an interrupted attempt
/// kept, or an upload from its staging file.
pub(super) async fn copy_file(
    sessions: &Sessions,
    progress: Option<&ProgressEmitter>,
    intent: &Intent,
    relative: &str,
    overwrite: bool,
    resume: bool,
    token: &CancellationToken,
) -> Result<()> {
    let source = intent.source.path(relative);
    let target = intent.target.path(relative);
    match (&intent.source, &intent.target) {
        (Endpoint::Local { .. }, Endpoint::Local { .. }) => {
            copy_local(&source, &target, overwrite, token).await
        }
        (Endpoint::Local { .. }, Endpoint::Remote { connection_id, .. }) => {
            Ok(transfer_service::transfer_upload(
                sessions,
                progress.context("Progress emitter unavailable")?,
                connection_id.clone(),
                format!("{}:file", intent.id),
                source,
                target,
                resume,
                Some(overwrite),
            )
            .await?)
        }
        (Endpoint::Remote { connection_id, .. }, Endpoint::Local { .. }) => {
            Ok(transfer_service::transfer_download(
                sessions,
                progress.context("Progress emitter unavailable")?,
                connection_id.clone(),
                format!("{}:file", intent.id),
                source,
                target,
                resume,
                Some(overwrite),
            )
            .await?)
        }
        (
            Endpoint::Remote {
                connection_id: source_id,
                ..
            },
            Endpoint::Remote {
                connection_id: target_id,
                ..
            },
        ) => Ok(transfer_service::transfer_remote_copy(
            sessions,
            progress.context("Progress emitter unavailable")?,
            source_id.clone(),
            target_id.clone(),
            format!("{}:file", intent.id),
            source,
            target,
            Some(overwrite),
        )
        .await?),
    }
}

/// Remote listing metadata is never authority for unconditional deletion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Stamp {
    Local(super::identity::Receipt),
    Remote { size: u64, modified: String },
}

pub(super) fn stamp_local(endpoint: &Endpoint, relative: &str) -> Result<Stamp> {
    let receipt = super::identity::capture(Path::new(&endpoint.path(relative)))?;
    anyhow::ensure!(!receipt.directory, "Destination is no longer a file");
    Ok(Stamp::Local(receipt))
}

/// What each of `relatives` holds on `endpoint` now. A name that is gone, is
/// no longer a file or cannot be read is left out. A server's folder is listed
/// once for all of its names: a listing per file made a walk through a folder
/// of thousands of files quadratic.
pub(super) async fn stamps<'a>(
    sessions: &Sessions,
    endpoint: &Endpoint,
    relatives: impl IntoIterator<Item = &'a String>,
    token: &CancellationToken,
) -> Result<HashMap<String, Stamp>> {
    check_cancel(token)?;
    let mut found = HashMap::new();
    let Endpoint::Remote { connection_id, .. } = endpoint else {
        for relative in relatives {
            if let Ok(stamp) = stamp_local(endpoint, relative) {
                found.insert(relative.clone(), stamp);
            }
        }
        return Ok(found);
    };
    let mut folders: HashMap<String, Vec<(&String, String)>> = HashMap::new();
    for relative in relatives {
        let path = endpoint.path(relative);
        if let Some((parent, name)) = path.rsplit_once('/') {
            let parent = if parent.is_empty() { "/" } else { parent };
            folders
                .entry(parent.to_owned())
                .or_default()
                .push((relative, name.to_owned()));
        }
    }
    for (parent, names) in folders {
        let parent = Endpoint::Remote {
            connection_id: connection_id.clone(),
            path: parent,
        };
        let Ok(entries) = listing(sessions, &parent, "", token).await else {
            check_cancel(token)?;
            continue;
        };
        let entries: HashMap<&str, &EntryInfo> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry))
            .collect();
        for (relative, name) in names {
            if let Some(entry) = entries.get(name.as_str())
                && !entry.is_directory
                && let Some(modified) = &entry.modified_at
            {
                found.insert(
                    relative.clone(),
                    Stamp::Remote {
                        size: entry.size,
                        modified: modified.clone(),
                    },
                );
            }
        }
    }
    Ok(found)
}

pub(super) async fn remove_created(
    _sessions: &Sessions,
    target: &Endpoint,
    relative: &str,
    expected: Option<&super::identity::Receipt>,
) -> Result<()> {
    let expected =
        expected.context("Object ownership cannot be proven; automatic deletion refused")?;
    remove_local(target, relative, expected, true).await
}

pub(super) async fn remove_local(
    target: &Endpoint,
    relative: &str,
    expected: &super::identity::Receipt,
    missing_ok: bool,
) -> Result<()> {
    anyhow::ensure!(
        matches!(target, Endpoint::Local { .. }),
        "Remote conditional deletion unavailable"
    );
    let path = target.path(relative);
    let _guard = mutations::guard().write().await;
    let Some((path, directory)) = safety::validated_delete_target(Path::new(&path)).await? else {
        anyhow::ensure!(missing_ok, "Source disappeared before deletion");
        return Ok(());
    };
    anyhow::ensure!(
        directory == expected.directory,
        "Object type changed; retained"
    );
    let file = super::identity::protect(&path, expected, true)?;
    super::identity::delete(&file)
}
