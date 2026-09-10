//! Local and protocol adapters used by recursive phases.
use super::manifest::Entry;
use super::model::{Endpoint, Intent, check_cancel, unit};
use crate::application::transfer_service;
use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::target_reservation::{Access, Reservation};
use crate::local_fs::{filesystem_safety as safety, mutations};
use crate::protocol::{EntryInfo, transfer_file};
use crate::session::Sessions;
use crate::transfer::progress::ProgressEmitter;
use anyhow::{Context, Result};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

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
            let slot = sessions.slot_for(connection_id);
            let mut guard = tokio::select! { guard = slot.lock() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
            let session = guard.as_mut().context("Remote session unavailable")?;
            let timeout = Duration::from_millis(if session.browse_timeout_ms == 0 {
                60_000
            } else {
                session.browse_timeout_ms
            });
            let result = tokio::select! {
                result = tokio::time::timeout(timeout, session.browse_client.list(&path)) => result.map_err(anyhow::Error::from).and_then(|r| r),
                _ = token.cancelled() => Err(CommandError::new(ErrorCode::Cancelled, "Recursive scan cancelled").into()),
            };
            if result.is_err() {
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

pub(super) async fn remote_task(
    sessions: &Sessions,
    connection: &str,
    id: String,
    token: &CancellationToken,
    task: crate::transfer::transfer_pool::TaskFn,
) -> Result<()> {
    let pool = sessions
        .pool_for(connection)
        .await
        .context("Remote session unavailable")?;
    let work = pool.run(id.clone(), task);
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        _ = token.cancelled() => { pool.cancel(&id); let _ = work.await; check_cancel(token) }
    }
}

/// Makes one target directory, answering whether this call created it rather
/// than finding it already there.
pub(super) async fn mkdir(
    sessions: &Sessions,
    target: &Endpoint,
    relative: &str,
    token: &CancellationToken,
) -> Result<bool> {
    let path = target.path(relative);
    match target {
        Endpoint::Local { .. } => {
            let _guard = tokio::select! { guard = mutations::guard().lock() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
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
                            let entries = backend
                                .list(if parent.is_empty() { "/" } else { parent })
                                .await?;
                            crate::protocol::validate_listing(&entries)?;
                            if let Some(existing) = entries.iter().find(|entry| entry.name == name)
                            {
                                anyhow::ensure!(
                                    existing.is_directory,
                                    "Destination directory is occupied by a file: {path}"
                                );
                                return Ok(());
                            }
                            let made = backend.mkdir(&path).await;
                            created_by_task.store(made.is_ok(), Ordering::SeqCst);
                            made
                        })
                        .await??;
                        Ok(())
                    })
                }),
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
    let _guard = tokio::select! { guard = mutations::guard().lock() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
    let source = Path::new(source);
    let target = Path::new(target);
    safety::validate_copy_relationship(source, target)?;
    safety::validate_read_source(source).await?;
    safety::validate_write_destination(target).await?;
    safety::ensure_path_no_reparse_points_now(source)?;
    safety::ensure_path_no_reparse_points_now(target)?;
    let temporary = target.with_file_name(format!(".ftpeach-{}.part", uuid::Uuid::new_v4()));
    let result = async {
        let mut input = tokio::fs::File::open(source).await?;
        let before = input.metadata().await?;
        let mut output = tokio::fs::File::from_std(transfer_file::open_artifact(&temporary, true)?);
        let mut limited = (&mut input).take(before.len().saturating_add(1));
        let bytes = tokio::select! {
            result = tokio::io::copy(&mut limited, &mut output) => result?,
            _ = token.cancelled() => { check_cancel(token)?; unreachable!() }
        };
        transfer_file::validate_length(bytes, Some(before.len()))?;
        let after = input.metadata().await?;
        anyhow::ensure!(
            before.len() == after.len() && before.modified()? == after.modified()?,
            "Source changed during copy"
        );
        output.flush().await?;
        output.sync_all().await?;
        drop(output);
        crate::protocol::ALLOW_OVERWRITE
            .scope(overwrite, transfer_file::commit(&temporary, target))
            .await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

/// Copies one file of the walk. `overwrite` may reach further than the
/// intent's, since the walk can always replace a file it wrote itself, and
/// `resume` carries a download on from the partial an interrupted attempt
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
        (Endpoint::Local { .. }, Endpoint::Remote { connection_id, .. }) => unit(
            transfer_service::transfer_upload(
                sessions,
                progress.context("Progress emitter unavailable")?,
                connection_id.clone(),
                format!("{}:file", intent.id),
                source,
                target,
                resume,
                Some(overwrite),
            )
            .await?,
        ),
        (Endpoint::Remote { connection_id, .. }, Endpoint::Local { .. }) => unit(
            transfer_service::transfer_download(
                sessions,
                progress.context("Progress emitter unavailable")?,
                connection_id.clone(),
                format!("{}:file", intent.id),
                source,
                target,
                resume,
                Some(overwrite),
            )
            .await?,
        ),
        (
            Endpoint::Remote {
                connection_id: source_id,
                ..
            },
            Endpoint::Remote {
                connection_id: target_id,
                ..
            },
        ) => unit(
            transfer_service::transfer_remote_copy(
                sessions,
                progress.context("Progress emitter unavailable")?,
                source_id.clone(),
                target_id.clone(),
                format!("{}:file", intent.id),
                source,
                target,
                Some(overwrite),
            )
            .await?,
        ),
    }
}

pub(super) async fn remove_entry(
    sessions: &Sessions,
    source: &Endpoint,
    entry: &Entry,
    token: &CancellationToken,
) -> Result<()> {
    let path = source.path(&entry.relative);
    match source {
        Endpoint::Local { .. } => {
            let _guard = tokio::select! { guard = mutations::guard().lock() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
            check_cancel(token)?;
            let (path, is_dir) = safety::validated_delete_target(Path::new(&path))
                .await?
                .context("Source disappeared before deletion")?;
            safety::ensure_path_no_reparse_points_now(&path)?;
            check_cancel(token)?;
            if is_dir {
                tokio::fs::remove_dir(path).await?;
            } else {
                tokio::fs::remove_file(path).await?;
            }
        }
        Endpoint::Remote { connection_id, .. } => {
            let directory = entry.directory;
            remote_task(
                sessions,
                connection_id,
                uuid::Uuid::new_v4().to_string(),
                token,
                Box::new(move |backend| {
                    Box::pin(async move {
                        if directory {
                            tokio::time::timeout(
                                Duration::from_secs(60),
                                backend.remove_empty_directory(&path),
                            )
                            .await??;
                        } else {
                            tokio::time::timeout(
                                Duration::from_secs(60),
                                backend.remove(&path, false),
                            )
                            .await??;
                        }
                        Ok(())
                    })
                }),
            )
            .await?;
        }
    }
    Ok(())
}

/// Removes one entry a stopped walk created on its target. A directory goes
/// only while it is empty, so nothing that appeared in it since is lost, and
/// an entry that is already gone is left that way.
pub(super) async fn remove_created(
    sessions: &Sessions,
    target: &Endpoint,
    relative: &str,
    directory: bool,
) -> Result<()> {
    let path = target.path(relative);
    match target {
        Endpoint::Local { .. } => {
            let _guard = mutations::guard().lock().await;
            let Some((path, is_dir)) = safety::validated_delete_target(Path::new(&path)).await?
            else {
                return Ok(());
            };
            anyhow::ensure!(is_dir == directory, "{} was replaced", path.display());
            safety::ensure_path_no_reparse_points_now(&path)?;
            if is_dir {
                tokio::fs::remove_dir(path).await?;
            } else {
                tokio::fs::remove_file(path).await?;
            }
            Ok(())
        }
        Endpoint::Remote { connection_id, .. } => {
            remote_task(
                sessions,
                connection_id,
                uuid::Uuid::new_v4().to_string(),
                &CancellationToken::new(),
                Box::new(move |backend| {
                    Box::pin(async move {
                        tokio::time::timeout(Duration::from_secs(60), async {
                            if !directory {
                                return backend.remove(&path, false).await;
                            }
                            // An upload the stop cut short may have left its
                            // staging file here. It is the walk's own, and it
                            // would keep the folder from going.
                            let mut others = 0;
                            for entry in backend.list(&path).await? {
                                if !entry.is_directory
                                    && transfer_service::is_staging_name(&entry.name)
                                {
                                    let staging =
                                        format!("{}/{}", path.trim_end_matches('/'), entry.name);
                                    backend.remove(&staging, false).await?;
                                } else {
                                    others += 1;
                                }
                            }
                            if backend.supports_empty_directory_remove() {
                                backend.remove_empty_directory(&path).await
                            } else {
                                // WebDAV deletes a collection along with all
                                // it holds, so only one still empty may go.
                                anyhow::ensure!(others == 0, "Folder is no longer empty: {path}");
                                backend.remove(&path, true).await
                            }
                        })
                        .await?
                    })
                }),
            )
            .await
        }
    }
}
