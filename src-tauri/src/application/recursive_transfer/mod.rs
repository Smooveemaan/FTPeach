//! Recursive scan, execute, verify and optional-delete coordination.
pub(crate) mod identity;
mod io;
mod journal;
mod manifest;
mod model;
mod scan;
mod stages;

use self::io::{Stamp, copy_file, listing, mkdir, remote_task, reserve, stamp_local, stamps};
use self::journal::{Journal, Paused};
use self::manifest::Entry;
use self::model::check_cancel;
pub use self::model::{Endpoint, Intent, Report};
use self::scan::scan;
use self::stages::{Walk, copy_files, make_directories, remove_source};
use crate::application::transfer_service::{self, CancelIntent};
use crate::application::upload_resume;
use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::target_reservation::{Access, Reservation};
use crate::local_fs::{filesystem_safety as safety, mutations};
use crate::session::Sessions;
use crate::transfer::progress::{Aggregate, FolderFile, ProgressEmitter, TransferProgressPayload};
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
    connections: Vec<String>,
}

pub(crate) fn close_connection(connection_id: &str) {
    for control in OPERATIONS.lock().unwrap().values() {
        if control.connections.iter().any(|id| id == connection_id) {
            control.pause.store(false, Ordering::SeqCst);
            control.token.cancel();
        }
    }
    journal::close_connection(connection_id);
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
pub async fn discard(sessions: &Sessions, id: &str) -> crate::ipc::CommandResult<()> {
    let Some(paused) = journal::take_any(id) else {
        return Err(CommandError::new(
            ErrorCode::CleanupIncomplete,
            "Recursive journal unavailable; previously written results may remain",
        ));
    };
    let sessions = sessions.clone();
    // Finish even if the IPC caller goes away, as the walk itself does.
    let errors = tokio::spawn(async move {
        // Something else may have started writing there since the pause, and
        // taking files back from under it could remove what it just wrote.
        match reserve(&sessions, &paused.target, Access::Write).await {
            Ok(_lease) => journal::take_back(&sessions, &paused.target, &paused.journal).await,
            Err(error) => vec![CommandError::new(
                ErrorCode::CleanupIncomplete,
                format!("Cleanup incomplete; files retained: {error:#}"),
            )],
        }
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))?;
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CommandError {
            code: ErrorCode::CleanupIncomplete,
            message: "Cleanup incomplete; unverified objects were retained".into(),
            details: Some(serde_json::to_string(&errors).unwrap_or_default()),
        })
    }
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
    mut journal: Journal,
    pause: bool,
    report: &mut Report,
) {
    journal.operation_id = intent.id.clone();
    journal.staging.clear();
    journal.staged.clear();
    if let Some(relative) = &journal.in_flight {
        match &intent.target {
            Endpoint::Remote { connection_id, .. } => {
                let key = crate::transfer::upload_staging::Key {
                    connection_id: connection_id.clone(),
                    remote_path: intent.target.path(relative),
                };
                journal
                    .staging
                    .extend(crate::transfer::upload_staging::staged_path(&key));
            }
            Endpoint::Local { .. } => {
                // The stopped download has just let go of these, so this is
                // still what it wrote, as a delivered file's receipt is.
                for path in crate::protocol::transfer_file::retained_paths(Path::new(
                    &intent.target.path(relative),
                )) {
                    let text = path.to_string_lossy().into_owned();
                    if let Ok(receipt) = identity::capture(&path) {
                        journal.staged.insert(text.clone(), receipt);
                    }
                    journal.staging.push(text);
                }
            }
        }
    }
    if pause {
        // What the walk delivered to a server is stamped here, one listing per
        // folder; a listing after every file made big folders crawl. A file
        // left unstamped fails the resume's check rather than being trusted.
        let unstamped: Vec<String> = journal
            .done
            .keys()
            .filter(|relative| !journal.targets.contains_key(*relative))
            .cloned()
            .collect();
        if let Ok(found) = stamps(
            sessions,
            &intent.target,
            &unstamped,
            &CancellationToken::new(),
        )
        .await
        {
            journal.targets.extend(found);
        }
        match journal::keep(
            intent.id.clone(),
            Paused {
                source: intent.source.clone(),
                target: intent.target.clone(),
                journal,
            },
        ) {
            Ok(()) => report.paused = true,
            Err(paused) => {
                report.errors.insert(0, CommandError::new(ErrorCode::CleanupIncomplete,
                    "Pause refused: recursive journal memory budget exhausted. Results retained; start a new transfer to retry."));
                // Release staging registry references without deleting unverified data.
                if let Endpoint::Remote { connection_id, .. } = &paused.target
                    && let Some(relative) = &paused.journal.in_flight
                {
                    let key = crate::transfer::upload_staging::Key {
                        connection_id: connection_id.clone(),
                        remote_path: paused.target.path(relative),
                    };
                    for path in &paused.journal.staging {
                        crate::transfer::upload_staging::forget_retained(&key, path);
                    }
                }
            }
        }
    } else {
        report
            .errors
            .extend(journal::take_back(sessions, &intent.target, &journal).await);
    }
}

/// Tells the walk's row what the walk is doing when called: "queued" while its
/// next step waits for a transfer connection or a free slot, "progress" once
/// it is at work. The row's numbers stay as they are.
fn status_notice(
    progress: Option<&ProgressEmitter>,
    intent: &Intent,
    status: &'static str,
) -> impl FnOnce() + Send + 'static {
    file_notice(progress, intent, status, None)
}

/// A status notice that also names the file the walk is on, or will start with.
fn file_notice(
    progress: Option<&ProgressEmitter>,
    intent: &Intent,
    status: &'static str,
    file: Option<FolderFile>,
) -> impl FnOnce() + Send + 'static {
    let progress = progress.cloned();
    let (id, connection_id) = (intent.id.clone(), intent.target.connection().to_owned());
    move || {
        if let Some(progress) = progress {
            progress.send(TransferProgressPayload {
                file,
                ..TransferProgressPayload::status(id, connection_id, status)
            });
        }
    }
}

async fn run_inner(
    sessions: &Sessions,
    progress: Option<&ProgressEmitter>,
    intent: Intent,
) -> Report {
    let mut report = Report::default();
    let mut wrote_target = false;
    let control = Control {
        connections: [&intent.source, &intent.target]
            .iter()
            .filter_map(|endpoint| match endpoint {
                Endpoint::Remote { connection_id, .. } => Some(connection_id.clone()),
                _ => None,
            })
            .collect(),
        ..Control::default()
    };
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
                    ErrorCode::ResumeExpired,
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
            transfer_service::transfer_validate_remote_copy(source.clone(), target.clone(), a.clone(), b.clone(), intent.moving)?;
            if intent.moving {
                // A move takes the source away as well as filling the target.
                let _source = reserve(sessions, &intent.source, Access::Write).await?;
                let _target = reserve(sessions, &intent.target, Access::Write).await?;
                let source = source.clone(); let target = target.clone(); let overwrite = intent.overwrite;
                remote_task(sessions, a, intent.id.clone(), &token, Box::new(move |backend| Box::pin(async move {
                    tokio::time::timeout(Duration::from_secs(60), async {
                        if overwrite { backend.rename(&source, &target).await } else { backend.rename_no_replace(&source, &target).await }
                    }).await?
                })), status_notice(progress, &intent, "progress")).await?;
                report.completed = 1;
                return Ok(());
            }
        }
        anyhow::ensure!(!intent.moving || matches!((&intent.source, &intent.target), (Endpoint::Local { .. }, Endpoint::Local { .. })),
            CommandError::new(ErrorCode::IntegrityMismatch, "Verified copy/delete Move requires local endpoints; use Copy instead. Remote rename remains supported."));
        leases.push(reserve(sessions, &intent.target, Access::Write).await?);
        // Any number of walks may send the same source at once; only a move,
        // which takes the source away, needs it to itself.
        let source_access = if intent.moving { Access::Write } else { Access::Read };
        leases.push(reserve(sessions, &intent.source, source_access).await?);
        // The walk has its turn: the row stops saying it is queued.
        status_notice(progress, &intent, "progress")();
        let mut manifest = scan(sessions, &intent.source, !intent.moving, &token).await?;
        let mut source_directories = HashMap::new();
        if intent.moving {
            for entry in manifest.entries.iter().filter(|entry| entry.directory) {
                source_directories.insert(entry.relative.clone(), identity::capture(Path::new(&intent.source.path(&entry.relative)))?);
            }
        }
        // Validate every old destination before allowing skips or overwrites,
        // including when the source changed and needs to be copied again.
        let current = stamps(sessions, &intent.target, journal.done.keys(), &token).await?;
        for relative in journal.done.keys() {
            anyhow::ensure!(current.get(relative).is_some_and(|current| journal.targets.get(relative) == Some(current)),
                CommandError::new(ErrorCode::IntegrityMismatch, format!("Destination changed or cannot be verified; resolve the conflict before restarting: {}", intent.target.path(relative))));
        }
        report.scanned = manifest.entries.len();
        let file_count = manifest.entries.iter().filter(|e| !e.directory).count() as u64;
        // Named while the folders wait their turn, before the files do.
        let first_file = manifest.entries.iter().find(|e| !e.directory).map(|e| FolderFile { number: 1, count: file_count, path: e.relative.clone() });
        for entry in &manifest.entries {
            if matches!(intent.target, Endpoint::Local { .. }) {
                // Each listed name on its own first: joined to the target, one
                // that starts with a drive (`d:name`) would leave the folder.
                for name in entry.relative.split('/').filter(|name| !name.is_empty()) { crate::local_fs::windows_names::validate_file_name(name)?; }
                mutations::validate_download_name(Path::new(&intent.target.path(&entry.relative)))?;
            }
        }
        // Names that stood in the target before this walk, which it must never
        // take back, nor write over when skipping. Only an overwrite or a skip
        // can meet one: any other copy that lands proves its name was free.
        let walk = Walk { sessions, progress, intent: &intent, token: &token };
        let existing_targets = make_directories(&walk, &manifest, &first_file, &mut journal, &mut wrote_target).await?;
        copy_files(&walk, &manifest, file_count, &existing_targets, &mut journal, &mut report).await?;
        anyhow::ensure!(report.errors.is_empty(), "Recursive copy was incomplete; source retained");
        check_cancel(&token)?;
        if intent.moving {
            remove_source(&walk, &mut manifest, &source_directories, &mut journal, &mut report).await?;
        }
        Ok(())
    }).await;
    if let Err(error) = &result
        && report.errors.len() < 100
    {
        report.errors.push(CommandError::from_anyhow(error));
    }
    report.landed = journal
        .created_dirs
        .len()
        .saturating_add(journal.done.len());
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
        progress.send(TransferProgressPayload::status(
            intent.id.clone(),
            intent.target.connection(),
            if report.ok { "done" } else { "error" },
        ));
    }
    report
}

#[cfg(test)]
mod tests;
