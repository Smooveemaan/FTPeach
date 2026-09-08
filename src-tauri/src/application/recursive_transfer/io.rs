//! Local and protocol adapters used by recursive phases.
use super::manifest::Entry;
use super::model::{Endpoint, Intent, check_cancel, unit};
use crate::application::transfer_service;
use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::{filesystem_safety as safety, mutations};
use crate::protocol::{EntryInfo, transfer_file};
use crate::session::Sessions;
use crate::transfer::progress::ProgressEmitter;
use anyhow::{Context, Result};
use std::{path::Path, time::Duration};
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

pub(super) async fn mkdir(
    sessions: &Sessions,
    target: &Endpoint,
    relative: &str,
    token: &CancellationToken,
) -> Result<()> {
    let path = target.path(relative);
    match target {
        Endpoint::Local { .. } => {
            let _guard = tokio::select! { guard = mutations::guard().lock() => guard, _ = token.cancelled() => { check_cancel(token)?; unreachable!() } };
            safety::validate_write_destination(Path::new(&path)).await?;
            safety::ensure_path_no_reparse_points_now(Path::new(&path))?;
            tokio::fs::create_dir_all(&path).await?;
            safety::ensure_path_no_reparse_points_now(Path::new(&path))?;
        }
        Endpoint::Remote { connection_id, .. } => {
            crate::protocol::validate_remote_path(&path)?;
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
                            backend.mkdir(&path).await
                        })
                        .await??;
                        Ok(())
                    })
                }),
            )
            .await?;
        }
    }
    Ok(())
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

pub(super) async fn copy_file(
    sessions: &Sessions,
    progress: Option<&ProgressEmitter>,
    intent: &Intent,
    relative: &str,
    token: &CancellationToken,
) -> Result<()> {
    let source = intent.source.path(relative);
    let target = intent.target.path(relative);
    match (&intent.source, &intent.target) {
        (Endpoint::Local { .. }, Endpoint::Local { .. }) => {
            copy_local(&source, &target, intent.overwrite, token).await
        }
        (Endpoint::Local { .. }, Endpoint::Remote { connection_id, .. }) => unit(
            transfer_service::transfer_upload(
                sessions,
                progress.context("Progress emitter unavailable")?,
                connection_id.clone(),
                format!("{}:file", intent.id),
                source,
                target,
                false,
                Some(intent.overwrite),
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
                false,
                Some(intent.overwrite),
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
                Some(intent.overwrite),
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
