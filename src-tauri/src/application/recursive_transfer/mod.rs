//! Recursive scan, execute, verify and optional-delete coordination.
mod io;
mod journal;
mod manifest;
mod model;
mod scan;

use self::io::{copy_file, listing, mkdir, remote_task, remove_entry};
use self::journal::{Journal, Paused};
use self::manifest::Entry;
pub use self::model::{Endpoint, Intent, Report};
use self::model::{check_cancel, unit};
use self::scan::scan;
use crate::application::transfer_service::{self, CancelIntent};
use crate::application::upload_resume;
use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::target_reservation::Reservation;
use crate::local_fs::{filesystem_safety as safety, mutations};
use crate::session::Sessions;
use crate::transfer::progress::{ProgressEmitter, TransferProgressPayload};
use anyhow::{Context, Result};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// How a running walk is told to end early, and whether it should keep what
/// it has written for a resume (a pause) or take it back (a stop).
#[derive(Clone, Default)]
struct Control {
    token: CancellationToken,
    pause: Arc<AtomicBool>,
}

static OPERATIONS: LazyLock<Mutex<HashMap<String, Control>>> = LazyLock::new(Default::default);
static CANCELLED_BEFORE_START: LazyLock<Mutex<VecDeque<(String, CancelIntent)>>> =
    LazyLock::new(Default::default);
struct Operation(String);
impl Drop for Operation {
    fn drop(&mut self) {
        OPERATIONS.lock().unwrap().remove(&self.0);
    }
}
pub fn cancel(id: &str, intent: CancelIntent) {
    if uuid::Uuid::parse_str(id).is_err() {
        return;
    }
    let operations = OPERATIONS.lock().unwrap();
    if let Some(control) = operations.get(id) {
        // A stop overrides a pause that is still winding down; a pause never
        // softens a stop already under way.
        match intent {
            CancelIntent::Pause if !control.token.is_cancelled() => {
                control.pause.store(true, Ordering::SeqCst);
            }
            CancelIntent::Pause => {}
            CancelIntent::Stop => control.pause.store(false, Ordering::SeqCst),
        }
        control.token.cancel();
    } else {
        let mut cancelled = CANCELLED_BEFORE_START.lock().unwrap();
        if cancelled.len() == 256 {
            cancelled.pop_front();
        }
        cancelled.push_back((id.to_owned(), intent));
    }
}

/// Takes back what a paused walk wrote, now that a stop means it will never
/// be resumed.
pub async fn discard(sessions: &Sessions, id: &str) {
    let Some(paused) = journal::take_any(id) else {
        return;
    };
    let sessions = sessions.clone();
    // Finish even if the IPC caller goes away, as the walk itself does.
    let _ = tokio::spawn(async move {
        // Something else may have started writing there since the pause, and
        // taking files back from under it could remove what it just wrote.
        match Reservation::acquire(&paused.target.path("")) {
            Ok(_lease) => journal::take_back(&sessions, &paused.target, &paused.journal).await,
            Err(error) => log::warn!("Kept a stopped folder transfer's files: {error:#}"),
        }
    })
    .await;
}

pub async fn run(
    sessions: &Sessions,
    progress: Option<&ProgressEmitter>,
    intent: Intent,
) -> Report {
    let sessions = sessions.clone();
    let progress = progress.cloned();
    // Retain leases and finish the active child even if the IPC caller drops.
    match tokio::spawn(async move { run_inner(&sessions, progress.as_ref(), intent).await }).await {
        Ok(report) => report,
        Err(error) => Report {
            outcome: "failed".into(),
            errors: vec![CommandError::new(ErrorCode::Internal, error.to_string())],
            ..Default::default()
        },
    }
}

/// Settles what an interrupted walk wrote: kept for the resume a pause
/// promises, or taken back because the user stopped it.
async fn wind_down(
    sessions: &Sessions,
    intent: &Intent,
    journal: Journal,
    pause: bool,
    report: &mut Report,
) {
    if pause {
        report.paused = true;
        journal::keep(
            intent.id.clone(),
            Paused {
                source: intent.source.clone(),
                target: intent.target.clone(),
                journal,
            },
        );
    } else {
        journal::take_back(sessions, &intent.target, &journal).await;
    }
}

async fn run_inner(
    sessions: &Sessions,
    progress: Option<&ProgressEmitter>,
    intent: Intent,
) -> Report {
    let mut report = Report::default();
    let mut wrote_target = false;
    let control = Control::default();
    let token = control.token.clone();
    let cancelled_before_start = {
        let mut operations = OPERATIONS.lock().unwrap();
        let mut cancelled = CANCELLED_BEFORE_START.lock().unwrap();
        if let Some(index) = cancelled.iter().position(|(id, _)| id == &intent.id) {
            cancelled.remove(index).map(|(_, how)| how)
        } else if operations.contains_key(&intent.id)
            || operations.len() >= 16
            || uuid::Uuid::parse_str(&intent.id).is_err()
        {
            report.outcome = "failed".into();
            report.errors.push(CommandError::new(
                ErrorCode::InvalidInput,
                "Duplicate recursive operation",
            ));
            return report;
        } else {
            operations.insert(intent.id.clone(), control.clone());
            None
        }
    };
    if let Some(how) = cancelled_before_start {
        report.outcome = "failed".into();
        report.errors.push(CommandError::new(
            ErrorCode::Cancelled,
            "Recursive operation cancelled before scanning",
        ));
        // Whatever the paused attempt left still goes the way the user chose.
        if let Some(previous) = &intent.resume_from
            && let Some(journal) = journal::take(previous, &intent.source, &intent.target)
        {
            wind_down(
                sessions,
                &intent,
                journal,
                how == CancelIntent::Pause,
                &mut report,
            )
            .await;
        }
        return report;
    }
    let _operation = Operation(intent.id.clone());
    // A resumed walk starts from what its paused attempt already put in place.
    let mut journal = match &intent.resume_from {
        None => Journal::default(),
        Some(previous) => match journal::take(previous, &intent.source, &intent.target) {
            Some(journal) => journal,
            None => {
                report.outcome = "failed".into();
                report.errors.push(CommandError::new(
                    ErrorCode::InvalidInput,
                    "This paused folder transfer can no longer be resumed; start it again",
                ));
                return report;
            }
        },
    };
    // Held until the walk has settled what it wrote, taking it back included.
    let mut leases: Vec<Reservation> = Vec::new();
    let result: Result<()> = crate::local_fs::target_reservation::OWNER.scope(intent.id.clone(), async {
        // Limit concurrent manifests as well as each manifest's own budget.
        static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
        let _slot = tokio::select! { slot = SLOTS.acquire() => slot?, _ = token.cancelled() => { check_cancel(&token)?; unreachable!() } };
        if let (Endpoint::Local { path: source }, Endpoint::Local { path: target }) = (&intent.source, &intent.target) {
            safety::validate_copy_relationship(Path::new(source), Path::new(target))?;
        }
        if let (Endpoint::Remote { path: source, connection_id: a }, Endpoint::Remote { path: target, connection_id: b }) = (&intent.source, &intent.target) {
            unit(transfer_service::transfer_validate_remote_copy(source.clone(), target.clone(), a.clone(), b.clone(), intent.moving))?;
            if intent.moving {
                let _lease = Reservation::acquire(target)?;
                let source = source.clone(); let target = target.clone(); let overwrite = intent.overwrite;
                remote_task(sessions, a, intent.id.clone(), &token, Box::new(move |backend| Box::pin(async move {
                    tokio::time::timeout(Duration::from_secs(60), async {
                        if overwrite { backend.rename(&source, &target).await } else { backend.rename_no_replace(&source, &target).await }
                    }).await?
                }))).await?;
                report.completed = 1;
                return Ok(());
            }
        }
        if intent.moving && let Endpoint::Remote { connection_id, .. } = &intent.source {
            let slot = sessions.slot_for(connection_id);
            let guard = slot.lock().await;
            anyhow::ensure!(guard.as_ref().is_some_and(|session| session.browse_client.supports_empty_directory_remove()), "Source protocol cannot safely remove only empty folders; use Copy instead");
        }
        leases.push(Reservation::acquire(&intent.target.path(""))?);
        leases.push(Reservation::acquire(&intent.source.path(""))?);
        let mut manifest = scan(sessions, &intent.source, &token).await?;
        report.scanned = manifest.entries.len();
        if intent.moving && matches!(intent.source, Endpoint::Remote { .. }) {
            anyhow::ensure!(manifest.entries.iter().all(|entry| entry.directory || entry.modified.is_some()), "Remote source lacks modification metadata required for a verified move; use Copy instead");
        }
        for entry in &manifest.entries {
            if matches!(intent.target, Endpoint::Local { .. }) { mutations::validate_download_name(Path::new(&intent.target.path(&entry.relative)))?; }
        }
        // Names that stood in the target before this walk, which it must never
        // take back, nor write over when skipping. Only an overwrite or a skip
        // can meet one: any other copy that lands proves its name was free.
        let note_existing = intent.overwrite || intent.skip_existing;
        let mut existing_targets = HashSet::new();
        let mut conflict_bytes = 0usize;
        let target_key = |relative: &str| if matches!(intent.target, Endpoint::Local { .. }) { relative.to_lowercase() } else { relative.to_owned() };
        for entry in manifest.entries.iter().filter(|e| e.directory) {
            check_cancel(&token)?;
            let created = mkdir(sessions, &intent.target, &entry.relative, &token).await.with_context(|| intent.target.path(&entry.relative))?;
            wrote_target = true;
            if created {
                journal.created_dirs.insert(entry.relative.clone());
            } else if note_existing && !journal.created_dirs.contains(&entry.relative) {
                for child in listing(sessions, &intent.target, &entry.relative, &token).await? {
                    let relative = if entry.relative.is_empty() { child.name } else { format!("{}/{}", entry.relative, child.name) };
                    conflict_bytes = conflict_bytes.saturating_add(relative.len() + std::mem::size_of::<String>());
                    anyhow::ensure!(conflict_bytes <= self::manifest::MAX_MANIFEST_BYTES, "Destination conflict manifest exceeds memory budget");
                    existing_targets.insert(target_key(&relative));
                    anyhow::ensure!(existing_targets.len() <= self::manifest::MAX_ENTRIES, "Destination conflict manifest exceeds entry budget");
                }
            }
        }
        // A file an earlier attempt delivered stands while its source is unchanged.
        let delivered = |journal: &Journal, entry: &Entry| journal.done.get(&entry.relative).is_some_and(|(size, modified)| *size == entry.size && *modified == entry.modified);
        // What the walk has put in place on its target so far.
        let landed = |journal: &Journal| journal.created_dirs.len().saturating_add(journal.done.len()) as u64;
        let total_bytes = manifest.entries.iter().fold(0u64, |total, entry| total.saturating_add(entry.size));
        // A resumed row carries on from the bytes its paused attempt delivered.
        let mut completed_bytes = manifest.entries.iter().filter(|entry| !entry.directory && delivered(&journal, entry)).fold(0u64, |total, entry| total.saturating_add(entry.size));
        // So does a file the pause cut short, which carries on from what it
        // kept; left out, the row would drop back to the files before it.
        let resumable = journal.in_flight.as_ref().and_then(|relative| {
            let entry = manifest.entries.iter().find(|entry| !entry.directory && &entry.relative == relative)?;
            let kept = match (&intent.source, &intent.target) {
                (Endpoint::Remote { .. }, Endpoint::Local { .. }) => crate::protocol::transfer_file::resumable_len(Path::new(&intent.target.path(relative))),
                (Endpoint::Local { .. }, Endpoint::Remote { connection_id, .. }) => upload_resume::staged_len(&upload_resume::Key { connection_id: connection_id.clone(), remote_path: intent.target.path(relative) }),
                _ => None,
            }?;
            Some(kept.min(entry.size))
        }).unwrap_or(0);
        // The scan is the first moment the size of the job is known; without
        // this the row shows "0 B / 0 B" until a file finishes. It is also the
        // moment the target's folders are all in place.
        if let Some(progress) = progress {
            progress.send(TransferProgressPayload {
                id: intent.id.clone(),
                connection_id: intent.target.connection().into(),
                status: "progress",
                bytes: Some(completed_bytes.saturating_add(resumable)),
                total: Some(total_bytes),
                error: None,
                error_code: None,
                landed: Some(landed(&journal)),
            });
        }
        for entry in manifest.entries.iter().filter(|e| !e.directory) {
            check_cancel(&token)?;
            if delivered(&journal, entry) {
                report.completed += 1;
                continue;
            }
            // The walk may always replace a file it wrote itself.
            let ours = journal.created_files.contains(&entry.relative);
            let existed = !ours && existing_targets.contains(&target_key(&entry.relative));
            if intent.skip_existing && existed {
                report.skipped += 1;
                continue;
            }
            // A download the pause cut short kept its partial; carry on from it.
            let resume = journal.in_flight.as_ref() == Some(&entry.relative);
            journal.done.remove(&entry.relative);
            journal.in_flight = Some(entry.relative.clone());
            // Roll this file's own byte reports into the walk's row, so a
            // single large file no longer looks frozen between boundaries.
            let _aggregate = progress.map(|progress| {
                progress.aggregate_into(
                    format!("{}:file", intent.id),
                    intent.id.clone(),
                    intent.target.connection().into(),
                    completed_bytes,
                    total_bytes,
                    landed(&journal),
                )
            });
            let copy = copy_file(sessions, progress, &intent, &entry.relative, intent.overwrite || ours, resume, &token);
            tokio::pin!(copy);
            let result = tokio::select! {
                result = &mut copy => result,
                _ = token.cancelled() => {
                    // Paused, an upload keeps its staging file for the resume
                    // to append to; unmarked, it deletes it on the way out.
                    if control.pause.load(Ordering::SeqCst) && matches!((&intent.source, &intent.target), (Endpoint::Local { .. }, Endpoint::Remote { .. })) {
                        upload_resume::mark_paused(&format!("{}:file", intent.id));
                    }
                    for endpoint in [&intent.source, &intent.target] {
                        if let Some(pool) = sessions.pool_for(endpoint.connection()).await {
                            pool.cancel(&format!("{}:file", intent.id)); pool.cancel(&format!("{}:file:src", intent.id)); pool.cancel(&format!("{}:file:dst", intent.id));
                        }
                    }
                    // A copy that landed before the cancel reached it still counts.
                    copy.await.or_else(|_| check_cancel(&token))
                }
            };
            match result {
                Ok(()) => {
                    report.completed += 1;
                    completed_bytes = completed_bytes.saturating_add(entry.size);
                    journal.done.insert(entry.relative.clone(), (entry.size, entry.modified.clone()));
                    if !existed { journal.created_files.insert(entry.relative.clone()); }
                    journal.in_flight = None;
                    // Lets a test interrupt the walk at a known point.
                    #[cfg(test)]
                    tests::after_file(&intent.id);
                },
                Err(error) => {
                    if report.errors.len() < 100 { report.errors.push(CommandError::from_anyhow(&error.context(intent.source.path(&entry.relative)))); }
                }
            }
            if let Some(progress) = progress { progress.send(TransferProgressPayload { id: intent.id.clone(), connection_id: intent.target.connection().into(), status: "progress", bytes: Some(completed_bytes), total: Some(total_bytes), error: None, error_code: None, landed: Some(landed(&journal)) }); }
        }
        anyhow::ensure!(report.errors.is_empty(), "Recursive copy was incomplete; source retained");
        check_cancel(&token)?;
        if intent.moving {
            anyhow::ensure!(report.skipped == 0, "Existing files were skipped; source retained");
            let mut verified = scan(sessions, &intent.source, &token).await?;
            manifest.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
            verified.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
            anyhow::ensure!(manifest.entries == verified.entries, "Source changed; copied files retained and source not deleted");
            // From here the target holds the only copy of what the source loses.
            journal.source_deletion_started = true;
            for entry in manifest.entries.iter().rev() {
                check_cancel(&token)?;
                remove_entry(sessions, &intent.source, entry, &token).await.with_context(|| intent.source.path(&entry.relative))?;
            }
        }
        Ok(())
    }).await;
    if let Err(error) = &result
        && report.errors.len() < 100
    {
        report.errors.push(CommandError::from_anyhow(error));
    }
    // Cut short by the user: keep what was written for a resume, or take it back.
    if result.is_err() && token.is_cancelled() {
        let pause = control.pause.load(Ordering::SeqCst);
        wind_down(sessions, &intent, journal, pause, &mut report).await;
    }
    drop(leases);
    report.ok = report.errors.is_empty();
    report.outcome = if report.ok {
        "complete"
    } else if report.completed > 0 || wrote_target {
        "partial"
    } else {
        "failed"
    }
    .into();
    // Progress payloads are batched behind a 100ms flush timer, so the walk's
    // last one would otherwise be emitted after this command has returned and
    // the renderer has already settled the row — reviving it as "in progress"
    // with nothing left running to finish it. A terminal payload supersedes
    // the pending one and carries the final byte count across.
    if let Some(progress) = progress {
        progress.send(TransferProgressPayload {
            id: intent.id.clone(),
            connection_id: intent.target.connection().into(),
            status: if report.ok { "done" } else { "error" },
            bytes: None,
            total: None,
            error: None,
            error_code: None,
            landed: None,
        });
    }
    report
}

#[cfg(test)]
mod tests;
