use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::security::vault::Vault;
use crate::security::vault_guard::VaultGuard;
use crate::store::Store;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, State, WindowEvent};
use zeroize::Zeroize;

const TOKEN_TTL: Duration = Duration::from_secs(30);

struct Grant {
    window: String,
    operation: String,
    target: String,
    expires: Instant,
}

struct PendingConfirmation {
    window: String,
    prompt: ConfirmationPrompt,
    response: tokio::sync::oneshot::Sender<bool>,
}

#[derive(Default)]
pub struct AuthorizationState {
    grants: Mutex<HashMap<String, Grant>>,
    pending: Mutex<HashMap<String, PendingConfirmation>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationToken {
    token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfirmationKind {
    RevealSiteSecret,
    RevealProxyPassword,
    VaultReset,
    ExecuteLocalFile,
    ExecuteRemoteFile,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationPrompt {
    kind: ConfirmationKind,
    locale: String,
    target: Option<String>,
    confirmation_phrase: Option<String>,
    requires_reauthentication: bool,
}

fn denied(message: &str) -> CommandError {
    CommandError::new(ErrorCode::PermissionDenied, message)
}

fn normalized_target(operation: &str, target: &str) -> CommandResult<String> {
    if matches!(
        operation,
        "fs_delete" | "fs_reveal_path" | "fs_open_document" | "fs_execute_path"
    ) {
        return std::fs::canonicalize(Path::new(target))
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|_| denied("The selected path is unavailable"));
    }
    Ok(target.to_owned())
}

fn requires_confirmation(operation: &str, target: &str) -> bool {
    matches!(
        operation,
        "sites_reveal_secret"
            | "settings_reveal_proxy_password"
            | "vault_reset"
            | "fs_execute_path"
    ) || (operation == "open_with_start"
        && crate::local_fs::local_open::is_executable(Path::new(target)))
}

fn should_show_confirmation(operation: &str, target: &str, enabled: bool) -> bool {
    requires_confirmation(operation, target) && (operation == "vault_reset" || enabled)
}

fn should_prompt(
    operation: &str,
    target: &str,
    confirmations_enabled: bool,
    requires_reauthentication: bool,
) -> bool {
    requires_reauthentication || should_show_confirmation(operation, target, confirmations_enabled)
}

fn issue_token(
    state: &AuthorizationState,
    window: &tauri::WebviewWindow,
    operation: String,
    target: String,
) -> CommandResult<AuthorizationToken> {
    let token = uuid::Uuid::new_v4().to_string();
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| denied("Authorization state unavailable"))?;
    grants.retain(|_, grant| grant.expires > Instant::now());
    grants.insert(
        token.clone(),
        Grant {
            window: window.label().to_owned(),
            operation,
            target,
            expires: Instant::now() + TOKEN_TTL,
        },
    );
    Ok(AuthorizationToken { token })
}

fn confirmation_prompt(
    operation: &str,
    target: &str,
    locale: String,
    requires_reauthentication: bool,
) -> CommandResult<ConfirmationPrompt> {
    let (kind, include_target) = match operation {
        "sites_reveal_secret" => (ConfirmationKind::RevealSiteSecret, false),
        "settings_reveal_proxy_password" => (ConfirmationKind::RevealProxyPassword, false),
        "vault_reset" => (ConfirmationKind::VaultReset, false),
        "fs_execute_path" => (ConfirmationKind::ExecuteLocalFile, true),
        "open_with_start" if crate::local_fs::local_open::is_executable(Path::new(target)) => {
            (ConfirmationKind::ExecuteRemoteFile, true)
        }
        _ => return Err(denied("Unsupported confirmation operation")),
    };
    Ok(ConfirmationPrompt {
        kind,
        locale,
        target: include_target.then(|| target.to_owned()),
        confirmation_phrase: (kind == ConfirmationKind::VaultReset).then(|| "RESET".into()),
        requires_reauthentication,
    })
}

fn reject_pending(state: &AuthorizationState, request_id: &str) {
    if let Some(pending) = state
        .pending
        .lock()
        .ok()
        .and_then(|mut map| map.remove(request_id))
    {
        let _ = pending.response.send(false);
    }
}

#[tauri::command]
pub fn sensitive_confirmation_prompt(
    window: tauri::WebviewWindow,
    state: State<'_, AuthorizationState>,
    request_id: String,
) -> CommandResult<ConfirmationPrompt> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| denied("PermissionDenied"))?;
    let request = pending
        .get(&request_id)
        .ok_or_else(|| denied("PermissionDenied"))?;
    if request.window != window.label() {
        return Err(denied("PermissionDenied"));
    }
    Ok(request.prompt.clone())
}

#[tauri::command]
pub async fn sensitive_confirmation_ready(
    window: tauri::WebviewWindow,
    state: State<'_, AuthorizationState>,
    request_id: String,
) -> CommandResult<()> {
    {
        let pending = state
            .pending
            .lock()
            .map_err(|_| denied("PermissionDenied"))?;
        pending
            .get(&request_id)
            .filter(|request| request.window == window.label())
            .ok_or_else(|| denied("PermissionDenied"))?;
    }

    crate::runtime::confirmation_window::show(&window).map_err(denied)
}

#[tauri::command]
pub async fn respond_sensitive_confirmation(
    window: tauri::WebviewWindow,
    state: State<'_, AuthorizationState>,
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    request_id: String,
    approved: bool,
    master_password: Option<String>,
) -> CommandResult<()> {
    let requires_reauthentication = {
        let pending = state
            .pending
            .lock()
            .map_err(|_| denied("PermissionDenied"))?;
        let request = pending
            .get(&request_id)
            .filter(|request| request.window == window.label())
            .ok_or_else(|| denied("PermissionDenied"))?;
        request.prompt.requires_reauthentication
    };
    if approved && requires_reauthentication {
        let mut password = master_password.unwrap_or_default();
        let permit = guard
            .acquire()
            .await
            .map_err(|_| denied("Authentication failed"))?;
        let verified = if vault.is_unlocked().await {
            vault.verify_password(&password).await.is_ok()
        } else {
            vault.unlock(&password).await.is_ok()
        };
        password.zeroize();
        if verified {
            guard.succeeded().await;
        } else {
            guard.failed().await;
        }
        drop(permit);
        if !verified {
            return Err(denied("Authentication failed"));
        }
    }
    let request = state
        .pending
        .lock()
        .map_err(|_| denied("PermissionDenied"))?
        .remove(&request_id)
        .ok_or_else(|| denied("PermissionDenied"))?;
    let _ = request.response.send(approved);
    let _ = window.close();
    Ok(())
}

#[tauri::command]
pub async fn authorize_sensitive(
    window: tauri::WebviewWindow,
    state: State<'_, AuthorizationState>,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    operation: String,
    target: String,
) -> CommandResult<AuthorizationToken> {
    const ALLOWED: &[&str] = &[
        "sites_reveal_secret",
        "settings_reveal_proxy_password",
        "vault_reset",
        "fs_delete",
        "fs_reveal_path",
        "fs_open_document",
        "fs_execute_path",
        "open_with_start",
        "app_export_settings",
        "app_import_settings",
    ];
    if window.label() != "main" || !ALLOWED.contains(&operation.as_str()) {
        return Err(denied(
            "Sensitive operation is not permitted for this window",
        ));
    }
    let target = normalized_target(&operation, &target)?;
    let settings = store.get_settings().await;
    let confirmations_enabled = settings
        .get("showSecurityConfirmations")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let requires_reauthentication = vault.is_configured()
        && matches!(
            operation.as_str(),
            "sites_reveal_secret" | "settings_reveal_proxy_password"
        );
    if !should_prompt(
        &operation,
        &target,
        confirmations_enabled,
        requires_reauthentication,
    ) {
        return issue_token(&state, &window, operation, target);
    }
    let locale = settings
        .get("language")
        .and_then(|value| value.as_str())
        .unwrap_or("en")
        .to_owned();
    let prompt = confirmation_prompt(&operation, &target, locale, requires_reauthentication)?;
    let app = window.app_handle().clone();
    let request_id = uuid::Uuid::new_v4().to_string();
    let confirmation_label = format!("security-confirmation-{request_id}");
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| denied("Authorization state unavailable"))?
        .insert(
            request_id.clone(),
            PendingConfirmation {
                window: confirmation_label.clone(),
                prompt: prompt.clone(),
                response: tx,
            },
        );
    let confirmation =
        match crate::runtime::confirmation_window::create(&app, &confirmation_label, &request_id) {
            Ok(window) => window,
            Err(_) => {
                reject_pending(&state, &request_id);
                return Err(denied("Confirmation could not be displayed"));
            }
        };
    let close_app = app.clone();
    let close_request_id = request_id.clone();
    confirmation.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            reject_pending(&close_app.state::<AuthorizationState>(), &close_request_id);
        }
    });
    let confirmed = match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(value)) => value,
        _ => {
            reject_pending(&state, &request_id);
            let _ = confirmation.close();
            false
        }
    };
    if !confirmed {
        return Err(CommandError::new(
            ErrorCode::Cancelled,
            "Operation was cancelled",
        ));
    }
    issue_token(&state, &window, operation, target)
}

pub fn consume(
    window: &tauri::WebviewWindow,
    state: &AuthorizationState,
    token: &str,
    operation: &str,
    target: &str,
) -> CommandResult<()> {
    consume_for_label(window.label(), state, token, operation, target)
}

fn consume_for_label(
    window_label: &str,
    state: &AuthorizationState,
    token: &str,
    operation: &str,
    target: &str,
) -> CommandResult<()> {
    if window_label != "main" {
        return Err(denied("PermissionDenied"));
    }
    let target = normalized_target(operation, target)?;
    let grant = state
        .grants
        .lock()
        .map_err(|_| denied("PermissionDenied"))?
        .remove(token)
        .ok_or_else(|| denied("PermissionDenied"))?;
    if grant.expires <= Instant::now()
        || grant.window != window_label
        || grant.operation != operation
        || grant.target != target
    {
        return Err(denied("PermissionDenied"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "sensitive_tests.rs"]
mod tests;
