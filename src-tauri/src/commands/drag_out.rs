use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION};
use crate::native_drag::DragOutFile;
use crate::session::Sessions;
use crate::transfer::progress::ProgressEmitter;
use tauri::{AppHandle, State, Window};

/// Starts a native OS drag-and-drop session for one or more remote files,
/// letting the user drop them onto Explorer (or Finder) to
/// download them. Unlike a plain "download to a temp path first" approach,
/// the actual transfer is lazy: the OS only pulls bytes from us once the
/// drop target asks for them (see `native_drag::windows` and `native_drag::macos`),
/// which is required for the native drag to work at all — the drag session must be
/// entered while the mouse button is still physically held, and any async work
/// (like a download) attempted first almost always loses that race.
///
/// Resolves once the drag gesture itself completes (dropped or cancelled);
/// the download a drop triggers keeps running in the background after that
/// and shows up in the Transfers panel like any other transfer, which is
/// what `protocol` is for (the row needs one, and this side doesn't
/// otherwise know it).
#[tauri::command]
pub async fn drag_out_start(
    window: Window,
    app: AppHandle,
    sessions: State<'_, Sessions>,
    progress: State<'_, ProgressEmitter>,
    connection_id: String,
    protocol: String,
    files: Vec<DragOutFile>,
) -> CommandResult<()> {
    if files.is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "No files to drag",
        ));
    }
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Err(CommandError::new(ErrorCode::ConnectionLost, NO_SESSION));
    };

    #[cfg(windows)]
    {
        // The address without the account, so a drop target can mark what
        // it writes as having come from this server.
        let origin_base = sessions.origin_base_for(&connection_id).await;
        let reporter = crate::native_drag::report::TransferReporter::new(
            app,
            progress.inner().clone(),
            connection_id,
            protocol,
        );
        match crate::native_drag::windows::start_drag(window, reporter, pool, files, origin_base)
            .await
        {
            Ok(()) => Ok(()),
            Err(err) => Err(CommandError::from_anyhow(&err)),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let origin_base = sessions.origin_base_for(&connection_id).await;
        let reporter = crate::native_drag::report::TransferReporter::new(
            app,
            progress.inner().clone(),
            connection_id,
            protocol,
        );
        match crate::native_drag::macos::start_drag(window, reporter, pool, files, origin_base)
            .await
        {
            Ok(()) => Ok(()),
            Err(err) => Err(CommandError::from_anyhow(&err)),
        }
    }
    #[cfg(target_os = "linux")]
    {
        use crate::application::recursive_transfer::{self, Endpoint, Intent};
        let _ = pool;
        let origin_base = sessions.origin_base_for(&connection_id).await;
        let sessions = sessions.inner().clone();
        let progress = progress.inner().clone();
        let entries = files.clone();
        let reporter = crate::native_drag::report::TransferReporter::new(
            app,
            progress.clone(),
            connection_id.clone(),
            protocol,
        );
        crate::native_drag::linux::start_drag(
            window,
            entries,
            Box::new(move |directory, publisher| {
                let work = directory.with_extension("download");
                std::fs::create_dir(&work)?;
                tauri::async_runtime::block_on(async move {
                    for file in files {
                        let id = uuid::Uuid::new_v4().to_string();
                        let target = work.join(&file.name);
                        reporter.started(&id, &file, file.size);
                        reporter.status(&id, "queued");
                        let outcome = if file.is_directory {
                            let published = publisher.clone();
                            let root = file.name.clone();
                            let source = target.clone();
                            let observer = std::sync::Arc::new(
                                move |event: recursive_transfer::Delivery<'_>| match event {
                                    recursive_transfer::Delivery::Listed(entries) => published
                                        .list(
                                            &root,
                                            entries.iter().map(|entry| {
                                                (
                                                    entry.relative.as_str(),
                                                    entry.directory,
                                                    entry.size,
                                                )
                                            }),
                                        ),
                                    recursive_transfer::Delivery::File(relative) => published.file(
                                        &std::path::Path::new(&root).join(relative),
                                        &source.join(relative),
                                    ),
                                },
                            );
                            let report = recursive_transfer::run_observed(
                                &sessions,
                                Some(&progress),
                                Intent {
                                    id: id.clone(),
                                    source: Endpoint::Remote {
                                        path: file.remote_path.clone(),
                                        connection_id: connection_id.clone(),
                                    },
                                    target: Endpoint::Local {
                                        path: target.to_string_lossy().into_owned(),
                                    },
                                    moving: false,
                                    overwrite: false,
                                    skip_existing: false,
                                    resume_from: None,
                                },
                                Some(observer),
                            )
                            .await;
                            if report.ok {
                                Ok(())
                            } else {
                                Err(report.errors.into_iter().next().unwrap_or_else(|| {
                                    CommandError::new(
                                        ErrorCode::Cancelled,
                                        "Drag download cancelled",
                                    )
                                }))
                            }
                        } else {
                            async {
                                publisher
                                    .list("", [(file.name.as_str(), false, file.size.unwrap_or(0))])
                                    .map_err(CommandError::from)?;
                                crate::application::transfer_service::transfer_download(
                                    &sessions,
                                    &progress,
                                    connection_id.clone(),
                                    id.clone(),
                                    file.remote_path.clone(),
                                    target.to_string_lossy().into_owned(),
                                    false,
                                    Some(false),
                                )
                                .await
                                .and_then(|()| {
                                    let origin = crate::local_fs::provenance::Origin::for_url(
                                        &origin_base,
                                        &file.remote_path,
                                    );
                                    crate::local_fs::provenance::mark(&target, &origin);
                                    publisher
                                        .file(std::path::Path::new(&file.name), &target)
                                        .map_err(CommandError::from)
                                })
                            }
                            .await
                        };
                        if let Err(error) = outcome {
                            reporter.error(&id, error.clone());
                            return Err(error);
                        }
                        let origin = crate::local_fs::provenance::Origin::for_url(
                            &origin_base,
                            &file.remote_path,
                        );
                        crate::local_fs::provenance::mark(&target, &origin);
                    }
                    Ok(())
                })
            }),
        )
        .await
        .map_err(CommandError::from)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (window, app, progress, pool, connection_id, protocol, files);
        Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Dragging files out to the OS file explorer isn't supported on this platform yet",
        ))
    }
}

/// Starts a native OS drag-and-drop session for files that already exist on
/// disk, so a local pane's selection can be dropped onto Explorer, Finder, the
/// desktop, or any other drop target. Nothing is transferred through us —
/// the shell copies the paths itself — so unlike `drag_out_start` there is
/// no session, no lazy download and no Transfers row.
///
/// Resolves once the drag gesture completes (dropped or cancelled).
#[tauri::command]
pub async fn drag_out_start_local(window: Window, paths: Vec<String>) -> CommandResult<()> {
    if paths.is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "No files to drag",
        ));
    }

    #[cfg(windows)]
    {
        match crate::native_drag::windows::start_local_drag(window, paths).await {
            Ok(()) => Ok(()),
            Err(err) => Err(CommandError::from_anyhow(&err)),
        }
    }
    #[cfg(target_os = "macos")]
    {
        match crate::native_drag::macos::start_local_drag(window, paths).await {
            Ok(()) => Ok(()),
            Err(err) => Err(CommandError::from_anyhow(&err)),
        }
    }
    #[cfg(target_os = "linux")]
    {
        crate::native_drag::linux::start_local_drag(window, paths)
            .await
            .map_err(CommandError::from)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (window, paths);
        Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Dragging files out to the OS file explorer isn't supported on this platform yet",
        ))
    }
}
