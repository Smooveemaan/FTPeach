use crate::ipc::{CommandError, CommandResult, ErrorCode, NO_SESSION};
use crate::local_fs::edit_recovery;
use crate::local_fs::local_open::{ApprovedLocalPaths, OpenKind};
use crate::local_fs::open_with::OpenWithWatchers;
use crate::local_fs::preview::{self, PreviewPaths};
use crate::security::open_with_intent::OpenWithIntent;
use crate::session::Sessions;
use crate::transfer::transfer_pool::TaskFn;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

// Admission includes the download and registration, so concurrent opens
// cannot all pass the same remaining storage budget.
static OPEN_ADMISSION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Where the copy an editor was opened on lives.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithStarted {
    /// The watched copy's id: the caller's own, or that of the copy already
    /// open for this file, which is reused.
    id: String,
    local_path: String,
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
    // Windows' own chooser picks the program, for a file with none given.
    choose: bool,
) -> CommandResult<OpenWithStarted> {
    if let Some(program) = application.as_deref() {
        approved_paths.preflight(std::path::Path::new(program))?;
    }
    let intent = OpenWithIntent::resolve(
        &connection_id,
        &remote_path,
        application.as_deref(),
        &approved_paths,
    )?;
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "open_with_start",
        &intent.grant_target(),
    )?;
    let _admission = OPEN_ADMISSION.lock().await;
    // A second copy of the same file would race the first back to the
    // server, and whichever saved last would silently win.
    let server = sessions.server_for(&connection_id).await;
    if let Some((watched, local_path)) = watchers.watched_copy(&server, &remote_path) {
        let (local_path, application) = reauthorized_launch(&approved_paths, &intent, &local_path)?;
        open_in(&app, &window, &local_path, application, choose).await?;
        return Ok(OpenWithStarted {
            id: watched,
            local_path: local_path.to_string_lossy().into_owned(),
        });
    }
    let recovery = recovery_root(&app)?;
    let session = paths.open_with_dir.clone();
    let check_session = session.clone();
    let check_recovery = recovery.clone();
    tokio::task::spawn_blocking(move || {
        edit_recovery::check_admission(&check_session, &check_recovery)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))?
    .map_err(|error| CommandError::from_anyhow(&error))?;
    let Some(pool) = sessions.pool_for(&connection_id).await else {
        return Err(CommandError::new(ErrorCode::ConnectionLost, NO_SESSION));
    };
    let dir = paths.open_with_dir.join(uuid::Uuid::new_v4().to_string());
    if let Err(err) = tokio::fs::create_dir_all(&dir).await {
        return Err(CommandError::from(err));
    }
    let local_path = dir.join(&intent.local_name);

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
        return Err(CommandError::from_anyhow(&err));
    }

    // Unknown remote sizes cannot bypass admission. This downloaded copy
    // has not reached an editor, so rejecting and removing it loses no edits.
    let admitted =
        tokio::task::spawn_blocking(move || edit_recovery::check_admission(&session, &recovery))
            .await
            .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))?;
    if let Err(error) = admitted {
        let _ = tokio::fs::remove_file(&local_path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
        return Err(CommandError::from_anyhow(&error));
    }

    approved_paths.approve_from_listing(&local_path);
    let (local_path, application) = match authorized_launch(&approved_paths, &intent, &local_path) {
        Ok(launch) => launch,
        Err(error) => {
            let _ = tokio::fs::remove_file(&local_path).await;
            let _ = tokio::fs::remove_dir(&dir).await;
            return Err(error);
        }
    };
    // Recorded before the editor can touch the copy, so a save made straight
    // after opening already differs from the recorded signature.
    watchers.register(&id, local_path.clone(), remote_path.clone());
    if let Err(error) = open_in(&app, &window, &local_path, application, choose).await {
        watchers.forget(&id);
        let _ = tokio::fs::remove_file(&local_path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
        return Err(error);
    }

    watchers.start(app, id.clone(), server);
    Ok(OpenWithStarted {
        id,
        local_path: local_path.to_string_lossy().into_owned(),
    })
}

async fn open_in(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    local_path: &Path,
    application: Option<PathBuf>,
    choose: bool,
) -> CommandResult<()> {
    if choose && application.is_none() {
        return open_with_chooser(window, local_path)
            .await
            .map_err(|err| CommandError::from_anyhow(&err));
    }
    let application = application.map(|path| crate::local_fs::local_open::shell_path(&path));
    app.opener()
        .open_path(local_path.to_string_lossy().into_owned(), application)
        .map_err(|err| CommandError::from_anyhow(&anyhow::anyhow!(err.to_string())))
}

/// Opens `path` in a program the user picks in Windows' own Open with
/// chooser, the one Explorer shows for "Choose another app". Its "Always use
/// this app" box is hidden: a pick here must not change the program Windows
/// opens this type of file with. Closing the chooser opens nothing.
async fn open_with_chooser(window: &tauri::WebviewWindow, path: &Path) -> anyhow::Result<()> {
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::UI::Shell::{
        OAIF_EXEC, OAIF_HIDE_REGISTRATION, OPENASINFO, SHOpenWithDialog,
    };
    use windows::core::{HRESULT, PCWSTR};

    // HWND is not Send, so its value crosses to the main thread instead.
    let owner = crate::runtime::confirmation_window::window_handle(window)?;
    let file: Vec<u16> = crate::local_fs::local_open::shell_path(path)
        .encode_utf16()
        .chain([0])
        .collect();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let info = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
        };
        let shown = unsafe { SHOpenWithDialog(Some(HWND(owner as *mut _)), &info) };
        let _ = tx.send(match shown {
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(()),
            other => other,
        });
    })?;
    Ok(rx.await??)
}

/// The grant covered this class of file and this program. The final path is
/// checked again right before launch: a document that became a program on
/// disk, or a program swapped since authorization, is refused.
fn authorized_launch(
    approved_paths: &ApprovedLocalPaths,
    intent: &OpenWithIntent,
    local_path: &Path,
) -> CommandResult<(PathBuf, Option<PathBuf>)> {
    let open_kind = if intent.executable {
        OpenKind::Execute
    } else {
        OpenKind::Document
    };
    let local_path = approved_paths.validate(local_path, open_kind)?;
    let application = match intent.application.as_deref() {
        Some(authorized) if approved_paths.recheck_application(authorized)? != authorized => {
            return Err(CommandError::new(
                ErrorCode::PermissionDenied,
                "PermissionDenied",
            ));
        }
        authorized => authorized.map(Path::to_path_buf),
    };
    Ok((local_path, application))
}

/// [`authorized_launch`] again for a copy already launched. Its recorded path
/// is the canonical `\\?\` form, which the path check refuses as typed text.
fn reauthorized_launch(
    approved_paths: &ApprovedLocalPaths,
    intent: &OpenWithIntent,
    recorded: &Path,
) -> CommandResult<(PathBuf, Option<PathBuf>)> {
    let recorded = PathBuf::from(crate::local_fs::local_open::shell_path(recorded));
    authorized_launch(approved_paths, intent, &recorded)
}

#[tauri::command]
pub fn open_with_stop(watchers: State<'_, OpenWithWatchers>, id: String) -> CommandResult<()> {
    watchers.stop(&id);
    Ok(())
}

/// Called once `revision` of the copy has been uploaded, and only then.
#[tauri::command]
pub fn open_with_mark_synced(
    watchers: State<'_, OpenWithWatchers>,
    id: String,
    revision: String,
) -> CommandResult<()> {
    if watchers.mark_synced(&id, &revision) {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::NotFound,
            "No such open-with copy",
        ))
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
        // Versions before persistent editor sessions used the OS temp dir.
        // Recover those copies too; they are never age-deleted as previews.
        let legacy = std::env::temp_dir()
            .join("ftpeach-openwith")
            .join("current-placeholder");
        edit_recovery::collect_abandoned(&legacy, &root);
        edit_recovery::list(&root)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))
}

/// Opens the recovery folder itself; the renderer never names a path here.
#[tauri::command]
pub fn open_with_reveal_recovered_edits(app: AppHandle) -> CommandResult<()> {
    let root = recovery_root(&app)?;
    app.opener()
        .open_path(root.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| CommandError::from_anyhow(&anyhow::anyhow!(error.to_string())))
}

#[tauri::command]
pub async fn open_with_discard_recovered_edits(app: AppHandle) -> CommandResult<()> {
    let root = recovery_root(&app)?;
    match tokio::task::spawn_blocking(move || edit_recovery::discard(&root)).await {
        Ok(result) => Ok(result?),
        Err(error) => Err(CommandError::new(ErrorCode::Internal, error.to_string())),
    }
}

// See commands/preview.rs's serde_field_casing module for why this needs
// its own per-variant rename_all and a test guarding it.
#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ftpeach-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Mirrors open_with_start: resolve, download under the resolved name,
    /// approve the copy, then check the launch. Nothing is executed.
    fn prepare(dir: &Path, remote: &str, application: Option<&Path>) -> (OpenWithIntent, PathBuf) {
        let approved = ApprovedLocalPaths::default();
        let intent = OpenWithIntent::resolve(
            "c1",
            remote,
            application.map(|path| path.to_str().unwrap()),
            &approved,
        )
        .unwrap();
        let local = dir.join(&intent.local_name);
        std::fs::write(&local, b"payload").unwrap();
        (intent, local)
    }

    #[test]
    fn names_that_turn_into_scripts_are_launched_only_as_programs() {
        let dir = workspace();
        let approved = ApprovedLocalPaths::default();
        for remote in ["/srv/report.cmd.", "/srv/report.cmd ", "/srv/Report.Ps1."] {
            let (intent, local) = prepare(&dir, remote, None);
            assert!(intent.executable, "{remote:?}");
            approved.approve_from_listing(&local);
            assert!(authorized_launch(&approved, &intent, &local).is_ok());
            let mut as_document = intent.clone();
            as_document.executable = false;
            assert_eq!(
                authorized_launch(&approved, &as_document, &local)
                    .unwrap_err()
                    .code,
                ErrorCode::PermissionDenied,
                "{remote:?}"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_launched_copy_can_be_launched_again_from_its_recorded_path() {
        let dir = workspace();
        let approved = ApprovedLocalPaths::default();
        let (intent, local) = prepare(&dir, "/srv/two.txt", None);
        approved.approve_from_listing(&local);
        let (recorded, _) = authorized_launch(&approved, &intent, &local).unwrap();
        let (again, _) = reauthorized_launch(&approved, &intent, &recorded).unwrap();
        assert_eq!(again, recorded);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_program_replaced_after_authorization_is_refused() {
        let dir = workspace();
        let editor = dir.join("editor.exe");
        let other = dir.join("other.exe");
        std::fs::write(&editor, b"MZ").unwrap();
        std::fs::write(&other, b"MZ").unwrap();
        let approved = ApprovedLocalPaths::default();
        let (mut intent, local) = prepare(&dir, "/srv/notes.txt", Some(&editor));
        approved.approve_from_listing(&local);
        let (_, application) = authorized_launch(&approved, &intent, &local).unwrap();
        assert_eq!(application, Some(std::fs::canonicalize(&editor).unwrap()));

        std::fs::remove_file(&editor).unwrap();
        assert!(authorized_launch(&approved, &intent, &local).is_err());
        intent.application = Some(dir.join("OTHER.exe.").join(".."));
        assert!(authorized_launch(&approved, &intent, &local).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ok_result_local_path_is_camel_case() {
        let value = serde_json::to_value(OpenWithStarted {
            id: "a".into(),
            local_path: "C:\\x".into(),
        })
        .unwrap();
        assert!(
            value.get("localPath").is_some(),
            "expected localPath, got {value}"
        );
    }
}
