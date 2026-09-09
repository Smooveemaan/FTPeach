use crate::application::upload_resume;
use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION, OkResult};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validate_read_source, validate_write_destination,
};
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
) -> OkResult {
    if !is_safe_path(&source_path) || !is_safe_path(&target_path) {
        return crate::ipc::err("Invalid remote path");
    }
    if source_connection_id != target_connection_id {
        // Different sessions can still expose the same filesystem through
        // aliases or different protocols. Without identity capabilities, a
        // recursive copy/delete cannot safely implement directory move.
        return if moving {
            crate::ipc::err("Cannot safely move folders between remote sessions; use Copy instead")
        } else {
            crate::ipc::ok()
        };
    }
    match crate::protocol::validate_remote_relationship(&source_path, &target_path) {
        Ok(()) => crate::ipc::ok(),
        Err(error) => crate::ipc::err(error),
    }
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
        // Unsupported replacement is an error, never delete-then-rename.
        if crate::protocol::overwrite_allowed() {
            backend.rename(partial, target).await
        } else {
            backend.rename_no_replace(partial, target).await
        }
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

/// Only an attempt's randomly named staging file is eligible for cleanup.
/// A disconnected server may retain that artifact; never fall back to deleting
/// the final destination. Retries use a fresh staging file and restart upload.
async fn cleanup_remote_partial(sessions: &Sessions, connection_id: &str, partial: &str) {
    let cleanup = async {
        let slot = sessions.slot_for(connection_id);
        let mut guard = slot.lock().await;
        if let Some(session) = guard.as_mut()
            && let Err(error) = session.browse_client.remove(partial, false).await
        {
            log::warn!("Could not clean transfer staging file {partial}: {error}");
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(5), cleanup)
        .await
        .is_err()
    {
        log::warn!("Timed out cleaning transfer staging file {partial}");
    }
}

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
            },
            ProgressInfo::Done => TransferProgressPayload {
                id: transfer_id.clone(),
                connection_id: connection_id.clone(),
                status: "done",
                bytes: None,
                total: None,
                error: None,
                error_code: None,
            },
            ProgressInfo::Error { error, code } => TransferProgressPayload {
                id: transfer_id.clone(),
                connection_id: connection_id.clone(),
                status: "error",
                bytes: None,
                total: None,
                error_code: Some(transfer_error_kind(code)),
                error: Some(error),
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
) -> CommandResult<OkResult> {
    if !is_safe_path(remote_path) {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, "Invalid remote path"),
        });
    }
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };
    let sink = make_progress_sink(progress.clone(), connection_id.clone(), transfer_id.clone());
    let on_dispatch = dispatch_notifier(progress.clone(), connection_id, transfer_id.clone());
    match pool
        .run_notified(transfer_id, task_for(sink), on_dispatch)
        .await
    {
        Ok(()) => Ok(OkResult::Ok { ok: true }),
        Err(err) => Ok(OkResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&err),
        }),
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
) -> CommandResult<OkResult> {
    let reservation = crate::local_fs::target_reservation::Reservation::acquire(&remote_path)
        .map_err(CommandError::from)?;
    let local = PathBuf::from(local_path);
    if let Err(error) = validate_read_source(&local).await {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, error.to_string()),
        });
    }
    // Pin the source before a byte moves. A later attempt may only append to
    // this attempt's staging file by proving it is still reading the same file.
    let Some(pin) = upload_resume::pin(&local).await else {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, "Cannot read the local file"),
        });
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
    let partial = adopted
        .map(|(staging, _)| staging)
        .unwrap_or_else(|| remote_partial_path(&remote_path));
    let partial_for_task = partial.clone();
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
    let paused = upload_resume::take_pause_mark(&transfer_id);
    if !matches!(&result, Ok(OkResult::Ok { ok: true }))
        && (resumed || started.load(std::sync::atomic::Ordering::SeqCst))
    {
        if paused {
            upload_resume::remember(key, partial, local_for_resume, pin);
        } else {
            cleanup_remote_partial(sessions, &cleanup_connection, &partial).await;
        }
    }
    result
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
) -> CommandResult<OkResult> {
    let owner = crate::local_fs::target_reservation::OWNER
        .try_with(Clone::clone)
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let local = PathBuf::from(local_path);
    if let Err(error) = validate_write_destination(&local).await {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, error.to_string()),
        });
    }
    run_pool_task(
        sessions,
        progress,
        connection_id,
        transfer_id,
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
    .await
}

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
) -> CommandResult<OkResult> {
    // Marked before the pool is told to cancel, so the upload this aborts is
    // guaranteed to observe the mark when it unwinds.
    if intent == CancelIntent::Pause {
        upload_resume::mark_paused(&transfer_id);
    }
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };
    Ok(OkResult::Ok {
        ok: pool.cancel(&transfer_id),
    })
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
) -> CommandResult<OkResult> {
    if !is_safe_path(&source_path) || !is_safe_path(&target_path) {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::InvalidInput, "Invalid remote path"),
        });
    }
    let reservation = Arc::new(
        crate::local_fs::target_reservation::Reservation::acquire(&target_path)
            .map_err(CommandError::from)?,
    );
    let Some(source_pool) = sessions.pool_for(&source_connection_id).await else {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };
    let Some(target_pool) = sessions.pool_for(&target_connection_id).await else {
        return Ok(OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };
    let dispatch_connection_id = target_connection_id.clone();
    let sink = make_progress_sink(progress.clone(), target_connection_id, transfer_id.clone());
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
    if result.is_err() && started.load(std::sync::atomic::Ordering::SeqCst) {
        cleanup_remote_partial(sessions, &dispatch_connection_id, &partial).await;
    }

    match &result {
        Ok(()) => sink(ProgressInfo::Done),
        Err(err) => sink(ProgressInfo::failed(err)),
    }
    match result {
        Ok(()) => Ok(OkResult::Ok { ok: true }),
        Err(err) => Ok(OkResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&err),
        }),
    }
}

pub async fn transfer_cancel_remote_copy(
    sessions: &Sessions,
    source_connection_id: String,
    target_connection_id: String,
    transfer_id: String,
) -> CommandResult<OkResult> {
    let source_pool = sessions.pool_for(&source_connection_id).await;
    let target_pool = sessions.pool_for(&target_connection_id).await;
    let a = source_pool
        .map(|p| p.cancel(&format!("{transfer_id}:src")))
        .unwrap_or(false);
    let b = target_pool
        .map(|p| p.cancel(&format!("{transfer_id}:dst")))
        .unwrap_or(false);
    Ok(OkResult::Ok { ok: a || b })
}
