//! Recursive scan, execute, verify and optional-delete coordination.
mod io;
mod manifest;
mod model;
mod scan;

use self::io::{copy_file, listing, mkdir, remote_task, remove_entry};
pub use self::model::{Endpoint, Intent, Report};
use self::model::{check_cancel, unit};
use self::scan::scan;
use crate::application::transfer_service;
use crate::ipc::{CommandError, ErrorCode};
use crate::local_fs::{filesystem_safety as safety, mutations};
use crate::session::Sessions;
use crate::transfer::progress::{ProgressEmitter, TransferProgressPayload};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

static OPERATIONS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(Default::default);
static CANCELLED_BEFORE_START: LazyLock<Mutex<std::collections::VecDeque<String>>> =
    LazyLock::new(Default::default);
struct Operation(String);
impl Drop for Operation {
    fn drop(&mut self) {
        OPERATIONS.lock().unwrap().remove(&self.0);
    }
}
pub fn cancel(id: &str) {
    if uuid::Uuid::parse_str(id).is_err() {
        return;
    }
    let operations = OPERATIONS.lock().unwrap();
    if let Some(token) = operations.get(id) {
        token.cancel();
    } else {
        let mut cancelled = CANCELLED_BEFORE_START.lock().unwrap();
        if cancelled.len() == 256 {
            cancelled.pop_front();
        }
        cancelled.push_back(id.to_owned());
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

async fn run_inner(
    sessions: &Sessions,
    progress: Option<&ProgressEmitter>,
    intent: Intent,
) -> Report {
    let mut report = Report::default();
    let mut wrote_target = false;
    let token = CancellationToken::new();
    {
        let mut operations = OPERATIONS.lock().unwrap();
        let mut cancelled = CANCELLED_BEFORE_START.lock().unwrap();
        if let Some(index) = cancelled.iter().position(|id| id == &intent.id) {
            cancelled.remove(index);
            report.outcome = "failed".into();
            report.errors.push(CommandError::new(
                ErrorCode::Cancelled,
                "Recursive operation cancelled before scanning",
            ));
            return report;
        }
        if operations.contains_key(&intent.id)
            || operations.len() >= 16
            || uuid::Uuid::parse_str(&intent.id).is_err()
        {
            report.outcome = "failed".into();
            report.errors.push(CommandError::new(
                ErrorCode::InvalidInput,
                "Duplicate recursive operation",
            ));
            return report;
        }
        operations.insert(intent.id.clone(), token.clone());
    }
    let _operation = Operation(intent.id.clone());
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
                let _lease = crate::local_fs::target_reservation::Reservation::acquire(target)?;
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
        let _target = crate::local_fs::target_reservation::Reservation::acquire(&intent.target.path(""))?;
        let _source = crate::local_fs::target_reservation::Reservation::acquire(&intent.source.path(""))?;
        let mut manifest = scan(sessions, &intent.source, &token).await?;
        report.scanned = manifest.entries.len();
        if intent.moving && matches!(intent.source, Endpoint::Remote { .. }) {
            anyhow::ensure!(manifest.entries.iter().all(|entry| entry.directory || entry.modified.is_some()), "Remote source lacks modification metadata required for a verified move; use Copy instead");
        }
        for entry in &manifest.entries {
            if matches!(intent.target, Endpoint::Local { .. }) { mutations::validate_download_name(Path::new(&intent.target.path(&entry.relative)))?; }
        }
        let mut existing_targets = std::collections::HashSet::new();
        let mut conflict_bytes = 0usize;
        let target_key = |relative: &str| if matches!(intent.target, Endpoint::Local { .. }) { relative.to_lowercase() } else { relative.to_owned() };
        for entry in manifest.entries.iter().filter(|e| e.directory) {
            check_cancel(&token)?;
            mkdir(sessions, &intent.target, &entry.relative, &token).await.with_context(|| intent.target.path(&entry.relative))?;
            wrote_target = true;
            if intent.skip_existing {
                for child in listing(sessions, &intent.target, &entry.relative, &token).await? {
                    let relative = if entry.relative.is_empty() { child.name } else { format!("{}/{}", entry.relative, child.name) };
                    conflict_bytes = conflict_bytes.saturating_add(relative.len() + std::mem::size_of::<String>());
                    anyhow::ensure!(conflict_bytes <= self::manifest::MAX_MANIFEST_BYTES, "Destination conflict manifest exceeds memory budget");
                    existing_targets.insert(target_key(&relative));
                    anyhow::ensure!(existing_targets.len() <= self::manifest::MAX_ENTRIES, "Destination conflict manifest exceeds entry budget");
                }
            }
        }
        let total_bytes = manifest.entries.iter().fold(0u64, |total, entry| total.saturating_add(entry.size));
        let mut completed_bytes = 0u64;
        // The scan is the first moment the size of the job is known; without
        // this the row shows "0 B / 0 B" until a file finishes.
        if let Some(progress) = progress {
            progress.send(TransferProgressPayload {
                id: intent.id.clone(),
                connection_id: intent.target.connection().into(),
                status: "progress",
                bytes: Some(0),
                total: Some(total_bytes),
                error: None,
                error_code: None,
            });
        }
        for entry in manifest.entries.iter().filter(|e| !e.directory) {
            check_cancel(&token)?;
            if existing_targets.contains(&target_key(&entry.relative)) {
                report.skipped += 1;
                continue;
            }
            // Roll this file's own byte reports into the walk's row, so a
            // single large file no longer looks frozen between boundaries.
            let _aggregate = progress.map(|progress| {
                progress.aggregate_into(
                    format!("{}:file", intent.id),
                    intent.id.clone(),
                    intent.target.connection().into(),
                    completed_bytes,
                    total_bytes,
                )
            });
            let copy = copy_file(sessions, progress, &intent, &entry.relative, &token);
            tokio::pin!(copy);
            let result = tokio::select! {
                result = &mut copy => result,
                _ = token.cancelled() => {
                    for endpoint in [&intent.source, &intent.target] {
                        if let Some(pool) = sessions.pool_for(endpoint.connection()).await {
                            pool.cancel(&format!("{}:file", intent.id)); pool.cancel(&format!("{}:file:src", intent.id)); pool.cancel(&format!("{}:file:dst", intent.id));
                        }
                    }
                    let _ = copy.await;
                    check_cancel(&token)
                }
            };
            match result {
                Ok(()) => { report.completed += 1; completed_bytes = completed_bytes.saturating_add(entry.size); },
                Err(error) => {
                    if report.errors.len() < 100 { report.errors.push(CommandError::from_anyhow(&error.context(intent.source.path(&entry.relative)))); }
                }
            }
            if let Some(progress) = progress { progress.send(TransferProgressPayload { id: intent.id.clone(), connection_id: intent.target.connection().into(), status: "progress", bytes: Some(completed_bytes), total: Some(total_bytes), error: None, error_code: None }); }
        }
        anyhow::ensure!(report.errors.is_empty(), "Recursive copy was incomplete; source retained");
        check_cancel(&token)?;
        if intent.moving {
            anyhow::ensure!(report.skipped == 0, "Existing files were skipped; source retained");
            let mut verified = scan(sessions, &intent.source, &token).await?;
            manifest.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
            verified.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
            anyhow::ensure!(manifest.entries == verified.entries, "Source changed; copied files retained and source not deleted");
            for entry in manifest.entries.iter().rev() {
                check_cancel(&token)?;
                remove_entry(sessions, &intent.source, entry, &token).await.with_context(|| intent.source.path(&entry.relative))?;
            }
        }
        Ok(())
    }).await;
    if let Err(error) = result
        && report.errors.len() < 100
    {
        report.errors.push(CommandError::from_anyhow(&error));
    }
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
        });
    }
    report
}

#[cfg(test)]
mod tests;
