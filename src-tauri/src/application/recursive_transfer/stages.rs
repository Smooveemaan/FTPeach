//! The stages of one walk after its scan: folders, files, and the removal
//! of a moved source.
use super::*;

/// What every stage of one walk works with.
#[derive(Clone, Copy)]
pub(super) struct Walk<'a> {
    pub(super) sessions: &'a Sessions,
    pub(super) progress: Option<&'a ProgressEmitter>,
    pub(super) intent: &'a Intent,
    pub(super) token: &'a CancellationToken,
}

/// How a target name is compared: Windows names ignore case.
fn target_key(intent: &Intent, relative: &str) -> String {
    if matches!(intent.target, Endpoint::Local { .. }) {
        relative.to_lowercase()
    } else {
        relative.to_owned()
    }
}

/// Creates the walk's folders on the target, recording the ones it made, and
/// returns the names already there when existing files are replaced or
/// skipped.
pub(super) async fn make_directories(
    walk: &Walk<'_>,
    manifest: &self::manifest::Manifest,
    first_file: &Option<FolderFile>,
    journal: &mut Journal,
    wrote_target: &mut bool,
) -> Result<HashSet<String>> {
    let Walk {
        sessions,
        progress,
        intent,
        token,
    } = *walk;
    let note_existing = intent.overwrite || intent.skip_existing;
    let mut existing_targets = HashSet::new();
    let mut conflict_bytes = 0usize;
    // Folders this attempt made: one an earlier attempt made may already hold more.
    let mut made_now = HashSet::new();
    for entry in manifest.entries.iter().filter(|e| e.directory) {
        check_cancel(token)?;
        // A folder made on a server waits its turn like a file sent there.
        if matches!(intent.target, Endpoint::Remote { .. }) {
            file_notice(progress, intent, "queued", first_file.clone())();
        }
        let parent = entry
            .relative
            .rsplit_once('/')
            .map_or("", |(parent, _)| parent);
        let fresh_parent = !entry.relative.is_empty() && made_now.contains(parent);
        let created = mkdir(
            sessions,
            &intent.target,
            &entry.relative,
            fresh_parent,
            token,
            status_notice(progress, intent, "progress"),
        )
        .await
        .map_err(|error| CommandError::at_path(error, intent.target.path(&entry.relative)))?;
        #[cfg(target_os = "macos")]
        if matches!(
            (&intent.source, &intent.target),
            (Endpoint::Remote { .. }, Endpoint::Local { .. })
        ) {
            crate::local_fs::provenance::mark_quarantine(Path::new(
                &intent.target.path(&entry.relative),
            ));
        }
        *wrote_target = true;
        if created {
            made_now.insert(entry.relative.as_str());
            journal.created_dirs.insert(entry.relative.clone());
            if matches!(intent.target, Endpoint::Local { .. }) {
                journal.directories.insert(
                    entry.relative.clone(),
                    identity::capture(Path::new(&intent.target.path(&entry.relative)))?,
                );
            }
        } else if note_existing && !journal.created_dirs.contains(&entry.relative) {
            for child in listing(sessions, &intent.target, &entry.relative, token).await? {
                let relative = if entry.relative.is_empty() {
                    child.name
                } else {
                    format!("{}/{}", entry.relative, child.name)
                };
                conflict_bytes =
                    conflict_bytes.saturating_add(relative.len() + std::mem::size_of::<String>());
                anyhow::ensure!(
                    conflict_bytes <= self::manifest::MAX_MANIFEST_BYTES,
                    "Destination conflict manifest exceeds memory budget"
                );
                existing_targets.insert(target_key(intent, &relative));
                anyhow::ensure!(
                    existing_targets.len() <= self::manifest::MAX_ENTRIES,
                    "Destination conflict manifest exceeds entry budget"
                );
            }
        }
    }
    // A file an earlier attempt delivered stands while its source is unchanged.
    Ok(existing_targets)
}

/// Copies the walk's files, recording each one delivered, and reports the
/// walk's bytes as it goes. A file that fails is reported and the rest go on.
pub(super) async fn copy_files(
    walk: &Walk<'_>,
    manifest: &self::manifest::Manifest,
    file_count: u64,
    existing_targets: &HashSet<String>,
    journal: &mut Journal,
    report: &mut Report,
) -> Result<()> {
    let Walk {
        sessions,
        progress,
        intent,
        token,
    } = *walk;
    let delivered = |journal: &Journal, entry: &Entry| {
        journal
            .done
            .get(&entry.relative)
            .is_some_and(|(size, modified)| *size == entry.size && *modified == entry.modified)
    };
    // What the walk has put in place on its target so far.
    let landed = |journal: &Journal| {
        journal
            .created_dirs
            .len()
            .saturating_add(journal.done.len()) as u64
    };
    let total_bytes = manifest
        .entries
        .iter()
        .fold(0u64, |total, entry| total.saturating_add(entry.size));
    // A resumed row carries on from the bytes its paused attempt delivered.
    let mut completed_bytes = manifest
        .entries
        .iter()
        .filter(|entry| !entry.directory && delivered(journal, entry))
        .fold(0u64, |total, entry| total.saturating_add(entry.size));
    // So does a file the pause cut short, which carries on from what it
    // kept; left out, the row would drop back to the files before it.
    let resumable = journal
        .in_flight
        .as_ref()
        .and_then(|relative| {
            let entry = manifest
                .entries
                .iter()
                .find(|entry| !entry.directory && &entry.relative == relative)?;
            let kept = match (&intent.source, &intent.target) {
                (Endpoint::Remote { .. }, Endpoint::Local { .. }) => {
                    crate::protocol::transfer_file::resumable_len(Path::new(
                        &intent.target.path(relative),
                    ))
                }
                (Endpoint::Local { .. }, Endpoint::Remote { connection_id, .. }) => {
                    upload_resume::staged_len(&upload_resume::Key {
                        connection_id: connection_id.clone(),
                        remote_path: intent.target.path(relative),
                    })
                }
                _ => None,
            }?;
            Some(kept.min(entry.size))
        })
        .unwrap_or(0);
    // The scan is the first moment the size of the job is known; without
    // this the row shows "0 B / 0 B" until a file finishes. It is also the
    // moment the target's folders are all in place.
    if let Some(progress) = progress {
        progress.send(TransferProgressPayload {
            bytes: Some(completed_bytes.saturating_add(resumable)),
            total: Some(total_bytes),
            landed: Some(landed(journal)),
            ..TransferProgressPayload::status(
                intent.id.clone(),
                intent.target.connection(),
                "progress",
            )
        });
    }
    for (number, entry) in (1..).zip(manifest.entries.iter().filter(|e| !e.directory)) {
        check_cancel(token)?;
        if delivered(journal, entry) {
            if let Some(expected) = journal.sources.get(&entry.relative) {
                anyhow::ensure!(
                    identity::capture(Path::new(&intent.source.path(&entry.relative)))?
                        == *expected,
                    CommandError::new(
                        ErrorCode::IntegrityMismatch,
                        "Source identity changed while paused; restart the operation"
                    )
                );
            }
            report.completed += 1;
            continue;
        }
        // Ownership affects rollback bookkeeping, not overwrite consent.
        // A receipt check cannot make a later unconditional rename safe
        // against external writers; never silently broaden consent.
        let ours = journal.created_files.contains(&entry.relative);
        let existed = !ours && existing_targets.contains(&target_key(intent, &entry.relative));
        if intent.skip_existing && existed {
            report.skipped += 1;
            continue;
        }
        // A download the pause cut short kept its partial; carry on from it.
        let resume = journal.in_flight.as_ref() == Some(&entry.relative);
        let source_receipt = if matches!(intent.source, Endpoint::Local { .. }) {
            Some(identity::capture(Path::new(
                &intent.source.path(&entry.relative),
            ))?)
        } else {
            None
        };
        journal.done.remove(&entry.relative);
        journal.in_flight = Some(entry.relative.clone());
        // The row names the file it is on, and how far through the files.
        let file = FolderFile {
            number,
            count: file_count,
            path: entry.relative.clone(),
        };
        // Roll this file's own byte reports into the walk's row, so a
        // single large file no longer looks frozen between boundaries.
        let _aggregate = progress.map(|progress| {
            progress.aggregate_into(
                format!("{}:file", intent.id),
                Aggregate {
                    parent_id: intent.id.clone(),
                    connection_id: intent.target.connection().into(),
                    base: completed_bytes,
                    total: total_bytes,
                    landed: landed(journal),
                    file: file.clone(),
                },
            )
        });
        // A file to or from a server waits for a connection and a free
        // transfer slot. The row says so until the file's own notice that
        // it has started, which the aggregate passes on.
        let local = matches!(
            (&intent.source, &intent.target),
            (Endpoint::Local { .. }, Endpoint::Local { .. })
        );
        file_notice(
            progress,
            intent,
            if local { "progress" } else { "queued" },
            Some(file),
        )();
        // Whether a file found at the name after a cancel can only be this one.
        let ours_if_found = match intent.target {
            Endpoint::Local { .. } => {
                std::fs::symlink_metadata(intent.target.path(&entry.relative)).is_err()
            }
            // Without overwrite, a name already taken would have failed the copy.
            Endpoint::Remote { .. } => !intent.overwrite,
        };
        let copy = copy_file(
            sessions,
            progress,
            intent,
            &entry.relative,
            intent.overwrite,
            resume,
            token,
        );
        tokio::pin!(copy);
        let result = tokio::select! {
            result = &mut copy => result,
            _ = token.cancelled() => {
                // Keep recursive staging for either cancellation intent:
                // Pause can resume it; Stop reports it as unverified and
                // forgets its registry entry without deleting by path.
                // A download's partial likewise: the walk itself takes it
                // back on a stop, by the receipt it records.
                if !matches!((&intent.source, &intent.target), (Endpoint::Local { .. }, Endpoint::Local { .. }) | (Endpoint::Remote { .. }, Endpoint::Remote { .. })) {
                    upload_resume::mark_paused(&format!("{}:file", intent.id));
                }
                for endpoint in [&intent.source, &intent.target] {
                    if let Some(pool) = sessions.pool_for(endpoint.connection()).await {
                        pool.cancel(&format!("{}:file", intent.id)); pool.cancel(&format!("{}:file:src", intent.id)); pool.cancel(&format!("{}:file:dst", intent.id));
                    }
                }
                // A copy that landed before the cancel reached it still counts.
                copy.await.or_else(|_| check_cancel(token))
            }
        };
        // A cancel cuts a file off wherever it is, even just after it was
        // put in place. One that landed whole counts as delivered: a resume
        // would find its name taken, and a stop would leave it behind.
        let result = match result {
            Err(_)
                if token.is_cancelled()
                    && ours_if_found
                    && matches!(
                        stamps(sessions, &intent.target, [&entry.relative], &CancellationToken::new()).await.ok().and_then(|mut found| found.remove(&entry.relative)),
                        Some(Stamp::Local(identity::Receipt { size, .. }) | Stamp::Remote { size, .. }) if size == entry.size
                    ) =>
            {
                Ok(())
            }
            result => result,
        };
        match result {
            Ok(()) => {
                if let Some(expected) = source_receipt {
                    anyhow::ensure!(
                        identity::capture(Path::new(&intent.source.path(&entry.relative)))?
                            == expected,
                        CommandError::new(
                            ErrorCode::IntegrityMismatch,
                            "Source changed during transfer; source retained"
                        )
                    );
                    journal.sources.insert(entry.relative.clone(), expected);
                }
                // Cancellation can race a successful commit. Capture the
                // receipt even then, so Stop can verify the landed file.
                // A server's files are stamped only if the walk pauses.
                if matches!(intent.target, Endpoint::Local { .. }) {
                    journal.targets.insert(
                        entry.relative.clone(),
                        stamp_local(&intent.target, &entry.relative)?,
                    );
                }
                report.completed += 1;
                completed_bytes = completed_bytes.saturating_add(entry.size);
                journal
                    .done
                    .insert(entry.relative.clone(), (entry.size, entry.modified.clone()));
                if !existed {
                    journal.created_files.insert(entry.relative.clone());
                }
                journal.in_flight = None;
                // Lets a test interrupt the walk at a known point.
                #[cfg(test)]
                tests::after_file(&intent.id);
            }
            Err(error) => {
                if report.errors.len() < 100 {
                    report
                        .errors
                        .push(CommandError::from_anyhow(&CommandError::at_path(
                            error,
                            intent.source.path(&entry.relative),
                        )));
                }
            }
        }
        if let Some(progress) = progress {
            progress.send(TransferProgressPayload {
                bytes: Some(completed_bytes),
                total: Some(total_bytes),
                landed: Some(landed(journal)),
                ..TransferProgressPayload::status(
                    intent.id.clone(),
                    intent.target.connection(),
                    "progress",
                )
            });
        }
    }
    Ok(())
}

/// Ends a move: checks the source is what was copied, then removes it, files
/// before their folders, each only while it still is what was copied.
pub(super) async fn remove_source(
    walk: &Walk<'_>,
    manifest: &mut self::manifest::Manifest,
    source_directories: &HashMap<String, identity::Receipt>,
    journal: &mut Journal,
    report: &mut Report,
) -> Result<()> {
    let Walk {
        sessions,
        intent,
        token,
        ..
    } = *walk;
    anyhow::ensure!(
        report.skipped == 0,
        "Existing files were skipped; source retained"
    );
    let mut verified = scan(sessions, &intent.source, false, token).await?;
    manifest.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
    verified.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
    anyhow::ensure!(
        manifest.entries == verified.entries,
        "Source changed; copied files retained and source not deleted"
    );
    #[cfg(test)]
    tests::before_delete(&intent.id);
    // From here the target holds the only copy of what the source loses.
    journal.source_deletion_started = true;
    for entry in manifest.entries.iter().rev() {
        check_cancel(token)?;
        let _target = if entry.directory {
            None
        } else {
            let Some(Stamp::Local(expected)) = journal.targets.get(&entry.relative) else {
                anyhow::bail!("Destination ownership unavailable; source retained");
            };
            Some(identity::protect(
                Path::new(&intent.target.path(&entry.relative)),
                expected,
                false,
            )?)
        };
        let expected = if entry.directory {
            source_directories.get(&entry.relative)
        } else {
            journal.sources.get(&entry.relative)
        }
        .context("Source identity unavailable; source retained")?;
        if let Err(error) = io::remove_local(&intent.source, &entry.relative, expected, false).await
        {
            let path = intent.source.path(&entry.relative);
            log::warn!(
                "Move copied every file, but could not remove the original {path}: {error:#}"
            );
            report.source_not_removed = Some(path.clone());
            return Err(CommandError::at_path(error, path));
        }
    }
    Ok(())
}
