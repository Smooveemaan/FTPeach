use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION, OkResult};
use crate::local_fs::edit_recovery;
use crate::local_fs::open_with::OpenWithWatchers;
use crate::local_fs::preview::{self, PreviewPaths};
use crate::security::connection_guard::safe_temp_name;
use crate::session::Sessions;
use crate::transfer::transfer_pool::TaskFn;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum OpenWithStartResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        ok: bool,
        local_path: String,
    },
    Err {
        ok: bool,
        error: CommandError,
    },
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_with_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    approved_paths: State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    authorization_token: String,
    sessions: State<'_, Sessions>,
    paths: State<'_, PreviewPaths>,
    watchers: State<'_, OpenWithWatchers>,
    connection_id: String,
    remote_path: String,
    id: String,
    application: Option<String>,
) -> CommandResult<OpenWithStartResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "open_with_start",
        &remote_path,
    )?;
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Ok(OpenWithStartResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::ConnectionLost, NO_SESSION),
        });
    };
    let name = remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(&remote_path)
        .to_string();
    let dir = paths.open_with_dir.join(now_millis().to_string());
    if let Err(err) = tokio::fs::create_dir_all(&dir).await {
        return Ok(OpenWithStartResult::Err {
            ok: false,
            error: CommandError::from(err),
        });
    }
    let local_path = dir.join(safe_temp_name(&name));

    let sink = preview::make_preview_progress_sink(app.clone(), connection_id.clone(), id.clone());
    let remote_path_task = remote_path.clone();
    let local_path_task = local_path.clone();
    let task: TaskFn = Box::new(move |backend| {
        Box::pin(async move {
            backend
                .download(&remote_path_task, &local_path_task, false, sink)
                .await
        })
    });
    if let Err(err) = pool.run(id.clone(), task).await {
        let _ = tokio::fs::remove_file(&local_path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
        return Ok(OpenWithStartResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&err),
        });
    }

    approved_paths.approve_from_listing(&local_path);
    let open_kind = if crate::local_fs::local_open::is_executable(&local_path) {
        crate::local_fs::local_open::OpenKind::Execute
    } else {
        crate::local_fs::local_open::OpenKind::Document
    };
    let local_path = approved_paths.validate(&local_path, open_kind)?;
    let application = application.filter(|value| !value.trim().is_empty());
    if let Some(executable) = application.as_deref()
        && approved_paths
            .validate(
                std::path::Path::new(executable),
                crate::local_fs::local_open::OpenKind::Execute,
            )
            .is_err()
    {
        let _ = tokio::fs::remove_file(&local_path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
        return Ok(OpenWithStartResult::Err {
            ok: false,
            error: CommandError::new(
                ErrorCode::InvalidInput,
                "Configured application was not found",
            ),
        });
    }
    // Recorded before the editor can touch the copy, so a save made straight
    // after opening already differs from the recorded signature.
    watchers.register(&id, local_path.clone(), remote_path.clone());
    if let Err(err) = app
        .opener()
        .open_path(local_path.to_string_lossy().into_owned(), application)
    {
        watchers.forget(&id);
        let _ = tokio::fs::remove_file(&local_path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
        return Ok(OpenWithStartResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&anyhow::anyhow!(err.to_string())),
        });
    }

    watchers.start(app, id);
    Ok(OpenWithStartResult::Ok {
        ok: true,
        local_path: local_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn open_with_stop(watchers: State<'_, OpenWithWatchers>, id: String) -> OkResult {
    watchers.stop(&id);
    OkResult::Ok { ok: true }
}

/// Called once `revision` of the copy has been uploaded, and only then.
#[tauri::command]
pub fn open_with_mark_synced(
    watchers: State<'_, OpenWithWatchers>,
    id: String,
    revision: String,
) -> OkResult {
    if watchers.mark_synced(&id, &revision) {
        OkResult::Ok { ok: true }
    } else {
        OkResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::NotFound, "No such open-with copy"),
        }
    }
}

fn recovery_root(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    edit_recovery::root(app)
        .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "No local data directory"))
}

/// Edits earlier runs could not upload. Collects sessions they left first,
/// so a crash is recovered as well as a normal exit.
#[tauri::command]
pub async fn open_with_recovered_edits(
    app: AppHandle,
    paths: State<'_, PreviewPaths>,
) -> Result<Vec<edit_recovery::RecoveredEdit>, CommandError> {
    let root = recovery_root(&app)?;
    let current = paths.open_with_dir.clone();
    tokio::task::spawn_blocking(move || {
        edit_recovery::collect_abandoned(&current, &root);
        edit_recovery::list(&root)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))
}

/// Opens the recovery folder itself; the renderer never names a path here.
#[tauri::command]
pub fn open_with_reveal_recovered_edits(app: AppHandle) -> Result<OkResult, CommandError> {
    let root = recovery_root(&app)?;
    Ok(
        match app
            .opener()
            .open_path(root.to_string_lossy().into_owned(), None::<String>)
        {
            Ok(()) => OkResult::Ok { ok: true },
            Err(error) => OkResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&anyhow::anyhow!(error.to_string())),
            },
        },
    )
}

#[tauri::command]
pub async fn open_with_discard_recovered_edits(app: AppHandle) -> Result<OkResult, CommandError> {
    let root = recovery_root(&app)?;
    Ok(
        match tokio::task::spawn_blocking(move || edit_recovery::discard(&root)).await {
            Ok(Ok(())) => OkResult::Ok { ok: true },
            Ok(Err(error)) => OkResult::Err {
                ok: false,
                error: CommandError::from(error),
            },
            Err(error) => OkResult::Err {
                ok: false,
                error: CommandError::new(ErrorCode::Internal, error.to_string()),
            },
        },
    )
}

// See commands/preview.rs's serde_field_casing module for why this needs
// its own per-variant rename_all and a test guarding it.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_result_local_path_is_camel_case() {
        let value = serde_json::to_value(OpenWithStartResult::Ok {
            ok: true,
            local_path: "C:\\x".into(),
        })
        .unwrap();
        assert!(
            value.get("localPath").is_some(),
            "expected localPath, got {value}"
        );
    }
}
