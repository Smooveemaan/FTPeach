use crate::application::upload_resume;
use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validate_read_source, validate_write_destination,
};
use crate::local_fs::target_reservation::{Access, Reservation};
use crate::protocol::{ProgressInfo, ProgressSink};
use crate::session::Sessions;
use crate::transfer::error_kind::transfer_error_kind;
use crate::transfer::progress::{ProgressEmitter, TransferProgressPayload};
use crate::transfer::transfer_pool::TaskFn;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(test)]
#[path = "transfer_service_tests.rs"]
mod tests;

fn is_safe_path(path: &str) -> bool {
    crate::security::connection_guard::is_safe_remote_path_argument(path)
}

pub fn transfer_validate_remote_copy(
    source_path: String,
    target_path: String,
    source_connection_id: String,
    target_connection_id: String,
    moving: bool,
) -> CommandResult<()> {
    if !is_safe_path(&source_path) || !is_safe_path(&target_path) {
        return Err(anyhow::anyhow!("Invalid remote path").into());
    }
    if source_connection_id != target_connection_id {
        // Different sessions can still expose the same filesystem through
        // aliases or different protocols. Without identity capabilities, a
        // recursive copy/delete cannot safely implement directory move.
        return if moving {
            Err(anyhow::anyhow!(
                "Cannot safely move folders between remote sessions; use Copy instead"
            )
            .into())
        } else {
            Ok(())
        };
    }
    Ok(crate::protocol::validate_remote_relationship(
        &source_path,
        &target_path,
    )?)
}

fn remote_partial_path(target: &str) -> String {
    let parent = target
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(".");
    format!("{parent}/.ftpeach-{}.part", uuid::Uuid::new_v4())
}

async fn upload_staged(
    backend: &mut crate::transfer::transfer_pool::BoxBackend,
    local: &std::path::Path,
    partial: &str,
    target: &str,
    resume: bool,
    sink: ProgressSink,
) -> anyhow::Result<()> {
    let progress_sink = sink.clone();
    let staged_sink: ProgressSink = Arc::new(move |info| {
        if matches!(info, ProgressInfo::Progress { .. }) {
            progress_sink(info);
        }
    });
    let result = async {
        backend.upload(local, partial, resume, staged_sink).await?;
        // A server that will not replace sets the old file aside; never delete-then-rename.
        if crate::protocol::overwrite_allowed() {
            backend.rename(partial, target).await?;
        } else {
            backend.rename_no_replace(partial, target).await?;
        }
        crate::protocol::remove_set_aside(backend.as_mut(), partial).await;
        Ok(())
    }
    .await;
    match &result {
        Ok(()) => sink(ProgressInfo::Done),
        Err(error) => sink(ProgressInfo::failed(error)),
    }
    result
}

async fn relay_staged(
    backend: &mut crate::transfer::transfer_pool::BoxBackend,
    partial: &str,
    target: &str,
    reader: tokio::io::DuplexStream,
    total: tokio::sync::oneshot::Receiver<Option<u64>>,
    complete: tokio::sync::oneshot::Receiver<bool>,
) -> anyhow::Result<()> {
    crate::transfer::relay::relay_upload(backend, partial, reader, total).await?;
    anyhow::ensure!(
        complete.await.unwrap_or(false),
        "Relay source did not complete successfully"
    );
    if crate::protocol::overwrite_allowed() {
        backend.rename(partial, target).await
    } else {
        backend.rename_no_replace(partial, target).await
    }
}

pub(crate) use crate::application::staging_cleanup::cleanup_remote_partial;

fn make_progress_sink(
    emitter: ProgressEmitter,
    connection_id: String,
    transfer_id: String,
) -> ProgressSink {
    Arc::new(move |info: ProgressInfo| {
        let payload = match info {
            ProgressInfo::Progress { bytes, total } => TransferProgressPayload {
                id: transfer_id.clone(),
                connection_id: connection_id.clone(),
                status: "progress",
                bytes: Some(bytes),
                total: Some(total),
                error: None,
                error_code: None,
                landed: None,
                file: None,
            },
            ProgressInfo::Done => TransferProgressPayload {
                id: transfer_id.clone(),
                connection_id: connection_id.clone(),
                status: "done",
                bytes: None,
                total: None,
                error: None,
                error_code: None,
                landed: None,
                file: None,
            },
            ProgressInfo::Error { error, code } => TransferProgressPayload {
                id: transfer_id.clone(),
                connection_id: connection_id.clone(),
                status: "error",
                bytes: None,
                total: None,
                error_code: Some(transfer_error_kind(code)),
                error: Some(error),
                landed: None,
                file: None,
            },
        };
        emitter.send(payload);
    })
}

async fn run_pool_task(
    sessions: &Sessions,
    progress: &ProgressEmitter,
    connection_id: String,
    transfer_id: String,
    remote_path: &str,
    task_for: impl FnOnce(ProgressSink) -> TaskFn,
) -> CommandResult<()> {
    if !is_safe_path(remote_path) {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Invalid remote path",
        ));
    }
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Err(CommandError::new(ErrorCode::ConnectionLost, NO_SESSION));
    };
    let sink = make_progress_sink(progress.clone(), connection_id.clone(), transfer_id.clone());
    let on_dispatch = dispatch_notifier(progress.clone(), connection_id, transfer_id.clone());
    match pool
        .run_notified(transfer_id, task_for(sink), on_dispatch)
        .await
    {
        Ok(()) => Ok(()),
        Err(err) => Err(CommandError::from_anyhow(&err)),
    }
}

/// A task sits in `TransferPool`'s queue, invisible to progress reporting,
/// until a worker frees up — the frontend has no way to tell "queued" apart
/// from "about to start" without this. Fired once, right as the task leaves
/// the queue, so the UI can drop its optimistic "queued" row state even
/// before any bytes have moved.
fn dispatch_notifier(
    emitter: ProgressEmitter,
    connection_id: String,
    transfer_id: String,
) -> impl FnOnce() + Send + 'static {
    move || {
        emitter.send(TransferProgressPayload {
            id: transfer_id,
            connection_id,
            status: "progress",
            bytes: None,
            total: None,
            error: None,
            error_code: None,
            landed: None,
            file: None,
        });
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_upload(
    sessions: &Sessions,
    progress: &ProgressEmitter,
    connection_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    resume: bool,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    let reservation =
        Reservation::acquire_remote(sessions, &connection_id, &remote_path, Access::Write)
            .await
            .map_err(CommandError::from)?;
    let server = sessions.server_for(&connection_id).await;
    let local = PathBuf::from(local_path);
    if let Err(error) = validate_read_source(&local).await {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            error.to_string(),
        ));
    }
    // Pin the source before a byte moves. A later attempt may only append to
    // this attempt's staging file by proving it is still reading the same file.
    let Some(pin) = upload_resume::pin(&local).await else {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Cannot read the local file",
        ));
    };
    let key = upload_resume::Key {
        connection_id: connection_id.clone(),
        remote_path: remote_path.clone(),
    };
    let adopted = if resume {
        upload_resume::resolve(sessions, &key, &local, pin).await
    } else {
        // A fresh upload supersedes whatever was staged for this destination.
        upload_resume::discard(sessions, &key).await;
        None
    };
    let resumed = adopted.is_some();
    // How far the staging file has come. A pause records it, so a folder
    // walk's row can show it before the next attempt has reported anything.
    let staged = Arc::new(std::sync::atomic::AtomicU64::new(
        adopted.as_ref().map_or(0, |(_, offset)| *offset),
    ));
    let staged_for_task = staged.clone();
    let partial = adopted
        .map(|(staging, _)| staging)
        .unwrap_or_else(|| remote_partial_path(&remote_path));
    let partial_for_task = partial.clone();
    // Recorded before the attempt runs, so a disconnect that overtakes it
    // still finds the file to delete.
    crate::transfer::upload_staging::begin(&transfer_id, key, partial.clone());
    let local_for_resume = local.to_string_lossy().into_owned();
    let cleanup_connection = connection_id.clone();
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let started_for_task = started.clone();
    let result = run_pool_task(
        sessions,
        progress,
        connection_id,
        transfer_id.clone(),
        &remote_path.clone(),
        move |sink| {
            let sink: ProgressSink = Arc::new(move |info| {
                if let ProgressInfo::Progress { bytes, .. } = &info {
                    staged_for_task.store(*bytes, std::sync::atomic::Ordering::SeqCst);
                }
                sink(info);
            });
            Box::new(move |backend| {
                Box::pin(async move {
                    let _reservation = reservation;
                    validate_read_source(&local).await?;
                    ensure_path_no_reparse_points_now(&local)?;
                    started_for_task.store(true, std::sync::atomic::Ordering::SeqCst);
                    crate::protocol::ALLOW_OVERWRITE
                        .scope(
                            overwrite.unwrap_or(false),
                            upload_staged(
                                backend,
                                &local,
                                &partial_for_task,
                                &remote_path,
                                resumed,
                                sink,
                            ),
                        )
                        .await
                })
            })
        },
    )
    .await;
    // The staging file exists on the server if this attempt adopted one or got
    // far enough to create its own. A pause hands it to the next attempt; every
    // other unfinished ending abandons it.
    let unfinished =
        result.is_err() && (resumed || started.load(std::sync::atomic::Ordering::SeqCst));
    let live = unfinished
        && sessions
            .pool_for(&cleanup_connection)
            .await
            .is_some_and(|pool| !pool.is_closed());
    let Some(partial) = crate::transfer::upload_staging::end_attempt(
        &transfer_id,
        unfinished,
        live,
        local_for_resume,
        pin,
        staged.load(std::sync::atomic::Ordering::SeqCst),
    ) else {
        return result;
    };
    if cleanup_remote_partial(sessions, &cleanup_connection, &partial).await {
        // Only now: a disconnect before the deletion reached the server
        // still finds the file through its record.
        crate::transfer::upload_staging::release(&transfer_id);
    }
    result.map_err(|error| interrupted_replacement(error, &partial, &server))
}

/// A replacement whose old file is still set aside after cleanup tried to put
/// it back is left for the next connection to `server`, and says so.
fn interrupted_replacement(error: CommandError, partial: &str, server: &str) -> CommandError {
    if !crate::protocol::strand_set_aside(partial, server) {
        return error;
    }
    CommandError::new(
        ErrorCode::ReplaceInterrupted,
        "The connection was lost while the file was being replaced. Its previous version will be put back the next time you connect to this server.",
    )
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_download(
    sessions: &Sessions,
    progress: &ProgressEmitter,
    connection_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    resume: bool,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    let owner = crate::local_fs::target_reservation::OWNER
        .try_with(Clone::clone)
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let local = PathBuf::from(local_path);
    if let Err(error) = validate_write_destination(&local).await {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            error.to_string(),
        ));
    }
    // An attempt carrying on from a pause now owns what that pause kept.
    PAUSED_DOWNLOADS
        .lock()
        .unwrap()
        .retain(|_, kept| *kept != local);
    let destination = local.clone();
    let result = run_pool_task(
        sessions,
        progress,
        connection_id,
        transfer_id.clone(),
        &remote_path.clone(),
        move |sink| {
            Box::new(move |backend| {
                Box::pin(async move {
                    validate_write_destination(&local).await?;
                    ensure_path_no_reparse_points_now(&local)?;
                    crate::local_fs::target_reservation::OWNER
                        .scope(
                            owner,
                            crate::protocol::ALLOW_OVERWRITE.scope(
                                overwrite.unwrap_or(false),
                                backend.download(&remote_path, &local, resume, sink),
                            ),
                        )
                        .await
                })
            })
        },
    )
    .await;
    // A pause keeps the partial for the next attempt; a stop leaves nothing.
    // Any other failure keeps it too: a retry carries on from it. The mark is
    // taken under the same lock a Stop takes, so a Stop that overtakes the
    // pause finds either the mark or the kept partial.
    let discard = {
        let mut kept = PAUSED_DOWNLOADS.lock().unwrap();
        let paused = upload_resume::take_pause_mark(&transfer_id);
        let cancelled = result
            .as_ref()
            .is_err_and(|error| error.code == ErrorCode::Cancelled);
        // Not capped: an entry leaves with the Resume or the Stop of its row,
        // and a disconnect stops every paused row.
        if cancelled && paused {
            kept.insert(transfer_id, destination.clone());
        }
        cancelled && !paused
    };
    if discard {
        crate::protocol::transfer_file::discard(&destination).await;
    }
    result
}

/// Paused downloads by attempt, so a stop that comes later can still take
/// back what the pause kept.
static PAUSED_DOWNLOADS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, PathBuf>>,
> = std::sync::LazyLock::new(Default::default);

/// Why a transfer is being cancelled. The pool cancels a task the same way
/// either way; the difference is what the aborted transfer is allowed to leave
/// behind, which is the transfer's decision to make rather than the caller's.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CancelIntent {
    Pause,
    Stop,
}

pub async fn transfer_cancel(
    sessions: &Sessions,
    connection_id: String,
    transfer_id: String,
    intent: CancelIntent,
) -> CommandResult<()> {
    // Marked before the pool is told to cancel, so the upload this aborts is
    // guaranteed to observe the mark when it unwinds.
    if intent == CancelIntent::Pause {
        upload_resume::mark_paused(&transfer_id);
    }
    // A stop after a pause: nothing runs, but the pause kept a partial or a
    // staging file. A stop overtaking a pause that is still unwinding takes
    // its mark back instead, and the transfer cleans up as a stopped one.
    if intent == CancelIntent::Stop {
        let kept = {
            let mut kept = PAUSED_DOWNLOADS.lock().unwrap();
            let staged = crate::transfer::upload_staging::stop(&transfer_id);
            (kept.remove(&transfer_id), staged)
        };
        if let Some(destination) = kept.0 {
            crate::protocol::transfer_file::discard(&destination).await;
        }
        if let Some((key, staging_path)) = kept.1 {
            cleanup_remote_partial(sessions, &key.connection_id, &staging_path).await;
        }
    }
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Err(CommandError::new(ErrorCode::ConnectionLost, NO_SESSION));
    };
    // A transfer that already ended has nothing left to cancel.
    pool.cancel(&transfer_id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_remote_copy(
    sessions: &Sessions,
    progress: &ProgressEmitter,
    source_connection_id: String,
    target_connection_id: String,
    transfer_id: String,
    source_path: String,
    target_path: String,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    if !is_safe_path(&source_path) || !is_safe_path(&target_path) {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Invalid remote path",
        ));
    }
    let reservation = Arc::new(
        Reservation::acquire_remote(sessions, &target_connection_id, &target_path, Access::Write)
            .await
            .map_err(CommandError::from)?,
    );
    let target_server = sessions.server_for(&target_connection_id).await;
    let Some(source_pool) = sessions.pool_for(&source_connection_id).await else {
        return Err(CommandError::new(ErrorCode::ConnectionLost, NO_SESSION));
    };
    let Some(target_pool) = sessions.pool_for(&target_connection_id).await else {
        return Err(CommandError::new(ErrorCode::ConnectionLost, NO_SESSION));
    };
    let dispatch_connection_id = target_connection_id.clone();
    let sink = make_progress_sink(progress.clone(), target_connection_id, transfer_id.clone());
    // A failure is reported against the connection that was lost, which a
    // pane shows as lost; the other leg only fails because its partner went.
    let source_sink = make_progress_sink(
        progress.clone(),
        source_connection_id.clone(),
        transfer_id.clone(),
    );
    let source_lost = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let source_lost_for_task = source_lost.clone();
    let src_task_id = format!("{transfer_id}:src");
    let dst_task_id = format!("{transfer_id}:dst");

    // A copy can't move a single byte until both legs have a worker, so
    // "dispatched" only means something once the pair of them agree.
    let legs_dispatched = Arc::new(std::sync::atomic::AtomicU8::new(0));
    let leg_dispatch_notifier = |legs_dispatched: Arc<std::sync::atomic::AtomicU8>| {
        let emitter = progress.clone();
        let connection_id = dispatch_connection_id.clone();
        let transfer_id = transfer_id.clone();
        move || {
            if legs_dispatched.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == 2 {
                emitter.send(TransferProgressPayload {
                    id: transfer_id,
                    connection_id,
                    status: "progress",
                    bytes: None,
                    total: None,
                    error: None,
                    error_code: None,
                    landed: None,
                    file: None,
                });
            }
        }
    };
    let src_on_dispatch = leg_dispatch_notifier(legs_dispatched.clone());
    let dst_on_dispatch = leg_dispatch_notifier(legs_dispatched);

    let (writer, reader) = tokio::io::duplex(crate::transfer::relay::RELAY_BUF_SIZE);
    let (total_tx, total_rx) = tokio::sync::oneshot::channel();
    let (complete_tx, complete_rx) = tokio::sync::oneshot::channel();
    let partial = remote_partial_path(&target_path);
    // Recorded before the copy runs, so a disconnect of the target that
    // overtakes it still finds the file to delete.
    crate::transfer::upload_staging::begin(
        &transfer_id,
        crate::transfer::upload_staging::Key {
            connection_id: dispatch_connection_id.clone(),
            remote_path: target_path.clone(),
        },
        partial.clone(),
    );
    let partial_for_task = partial.clone();
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let started_for_task = started.clone();

    let source_reservation = reservation.clone();
    let source_path_for_task = source_path.clone();
    let sink_for_download = sink.clone();
    let src_task: TaskFn = Box::new(move |src_backend| {
        Box::pin(async move {
            let _reservation = source_reservation;
            let result = crate::transfer::relay::relay_download(
                src_backend,
                &source_path_for_task,
                writer,
                total_tx,
                sink_for_download,
            )
            .await;
            source_lost_for_task.store(
                result.as_ref().is_err_and(|error| {
                    error
                        .downcast_ref::<crate::transfer::relay::PartnerGone>()
                        .is_none()
                }),
                std::sync::atomic::Ordering::SeqCst,
            );
            let _ = complete_tx.send(result.is_ok());
            result
        })
    });
    let target_path_for_task = target_path.clone();
    let dst_task: TaskFn = Box::new(move |dst_backend| {
        Box::pin(async move {
            let _reservation = reservation;
            started_for_task.store(true, std::sync::atomic::Ordering::SeqCst);
            crate::protocol::ALLOW_OVERWRITE
                .scope(
                    overwrite.unwrap_or(false),
                    relay_staged(
                        dst_backend,
                        &partial_for_task,
                        &target_path_for_task,
                        reader,
                        total_rx,
                        complete_rx,
                    ),
                )
                .await
        })
    });

    let result = source_pool
        .run_pair(
            &target_pool,
            (src_task_id, src_task, Box::new(src_on_dispatch)),
            (dst_task_id, dst_task, Box::new(dst_on_dispatch)),
        )
        .await;
    let mut result = result.map_err(|err| CommandError::from_anyhow(&err));
    if result.is_ok() || !started.load(std::sync::atomic::Ordering::SeqCst) {
        crate::transfer::upload_staging::release(&transfer_id);
    } else {
        // While the target is closing, its teardown deletes the file through
        // the record; otherwise the record goes once the deletion has reached
        // the server.
        let live = sessions
            .pool_for(&dispatch_connection_id)
            .await
            .is_some_and(|pool| !pool.is_closed());
        if live && cleanup_remote_partial(sessions, &dispatch_connection_id, &partial).await {
            crate::transfer::upload_staging::release(&transfer_id);
        }
        result = result.map_err(|error| interrupted_replacement(error, &partial, &target_server));
    }

    match &result {
        Ok(()) => sink(ProgressInfo::Done),
        Err(err) => {
            let lost = if source_lost.load(std::sync::atomic::Ordering::SeqCst) {
                &source_sink
            } else {
                &sink
            };
            lost(ProgressInfo::Error {
                error: err.message.clone(),
                code: err.code,
            })
        }
    }
    result
}

pub async fn transfer_cancel_remote_copy(
    sessions: &Sessions,
    source_connection_id: String,
    target_connection_id: String,
    transfer_id: String,
) -> CommandResult<()> {
    let source_pool = sessions.pool_for(&source_connection_id).await;
    let target_pool = sessions.pool_for(&target_connection_id).await;
    if let Some(pool) = source_pool {
        pool.cancel(&format!("{transfer_id}:src"));
    }
    if let Some(pool) = target_pool {
        pool.cancel(&format!("{transfer_id}:dst"));
    }
    Ok(())
}
