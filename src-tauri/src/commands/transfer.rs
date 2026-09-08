//! Transfer IPC adapters. Workflows live in the application layer.
use crate::ipc::{CommandResult, OkResult};
use crate::session::Sessions;
use crate::transfer::progress::ProgressEmitter;
use tauri::State;

#[tauri::command]
pub async fn transfer_recursive(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    sessions: State<'_, Sessions>,
    progress: State<'_, ProgressEmitter>,
    intent: crate::application::recursive_transfer::Intent,
    authorization_token: Option<String>,
) -> CommandResult<crate::application::recursive_transfer::Report> {
    if intent.moving
        && let crate::application::recursive_transfer::Endpoint::Local { path } = &intent.source
    {
        crate::security::sensitive::consume(
            &window,
            &authorization,
            authorization_token.as_deref().unwrap_or(""),
            "fs_delete",
            path,
        )?;
    }
    Ok(crate::application::recursive_transfer::run(&sessions, Some(&progress), intent).await)
}

#[tauri::command]
pub fn transfer_cancel_recursive(id: String) {
    crate::application::recursive_transfer::cancel(&id);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn transfer_validate_remote_copy(
    source_path: String,
    target_path: String,
    source_connection_id: String,
    target_connection_id: String,
    moving: bool,
) -> OkResult {
    crate::application::transfer_service::transfer_validate_remote_copy(
        source_path,
        target_path,
        source_connection_id,
        target_connection_id,
        moving,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_upload(
    sessions: State<'_, Sessions>,
    progress: State<'_, ProgressEmitter>,
    connection_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    resume: bool,
    overwrite: Option<bool>,
) -> CommandResult<OkResult> {
    crate::application::transfer_service::transfer_upload(
        &sessions,
        &progress,
        connection_id,
        transfer_id,
        local_path,
        remote_path,
        resume,
        overwrite,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_download(
    sessions: State<'_, Sessions>,
    progress: State<'_, ProgressEmitter>,
    connection_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    resume: bool,
    overwrite: Option<bool>,
) -> CommandResult<OkResult> {
    crate::application::transfer_service::transfer_download(
        &sessions,
        &progress,
        connection_id,
        transfer_id,
        remote_path,
        local_path,
        resume,
        overwrite,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_cancel(
    sessions: State<'_, Sessions>,
    connection_id: String,
    transfer_id: String,
) -> CommandResult<OkResult> {
    crate::application::transfer_service::transfer_cancel(&sessions, connection_id, transfer_id)
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_remote_copy(
    sessions: State<'_, Sessions>,
    progress: State<'_, ProgressEmitter>,
    source_connection_id: String,
    target_connection_id: String,
    transfer_id: String,
    source_path: String,
    target_path: String,
    overwrite: Option<bool>,
) -> CommandResult<OkResult> {
    crate::application::transfer_service::transfer_remote_copy(
        &sessions,
        &progress,
        source_connection_id,
        target_connection_id,
        transfer_id,
        source_path,
        target_path,
        overwrite,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_cancel_remote_copy(
    sessions: State<'_, Sessions>,
    source_connection_id: String,
    target_connection_id: String,
    transfer_id: String,
) -> CommandResult<OkResult> {
    crate::application::transfer_service::transfer_cancel_remote_copy(
        &sessions,
        source_connection_id,
        target_connection_id,
        transfer_id,
    )
    .await
}
