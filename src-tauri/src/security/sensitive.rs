use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::local_open::ApprovedLocalPaths;
use crate::security::open_with_intent::OpenWithIntent;
use crate::security::security_policy::{self, Weakening};
use crate::security::vault::Vault;
use crate::security::vault_guard::VaultGuard;
use crate::store::{JsonMap, Store};
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
    vault_epoch: u64,
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
    /// A grant dies with the vault session it was issued in.
    vault: Option<Vault>,
}

impl AuthorizationState {
    pub fn new(vault: Vault) -> Self {
        Self {
            vault: Some(vault),
            ..Self::default()
        }
    }

    fn vault_epoch(&self) -> u64 {
        self.vault.as_ref().map_or(0, Vault::lock_epoch)
    }

    /// Withdraws every unused grant, after a security policy changed.
    pub fn revoke_all(&self) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.clear();
        }
    }
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
    OpenWithApplication,
    WeakenSecuritySettings,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationPrompt {
    kind: ConfirmationKind,
    locale: String,
    target: Option<String>,
    /// The name a downloaded file is saved under, when it differs.
    local_name: Option<String>,
    /// The program that opens the file, when one is configured.
    application: Option<String>,
    /// The protection a settings change would turn off or relax.
    security_changes: Option<Weakening>,
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

fn requires_confirmation(operation: &str) -> bool {
    matches!(
        operation,
        "sites_reveal_secret"
            | "settings_reveal_proxy_password"
            | "vault_reset"
            | "fs_execute_path"
    )
}

/// Launching a program or script needs a confirmation, and so does handing
/// even a document to a program the user has not chosen before.
fn open_with_requires_confirmation(intent: &OpenWithIntent, application_trusted: bool) -> bool {
    intent.executable || (intent.application.is_some() && !application_trusted)
}

/// Vault reset, and weakening the settings that decide about prompts, are
/// confirmed whatever those settings say.
fn should_show_confirmation(operation: &str, required: bool, enabled: bool) -> bool {
    required && (matches!(operation, "vault_reset" | "settings_set_security") || enabled)
}

fn should_prompt(
    operation: &str,
    required: bool,
    confirmations_enabled: bool,
    requires_reauthentication: bool,
) -> bool {
    requires_reauthentication
        || should_show_confirmation(operation, required, confirmations_enabled)
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
            vault_epoch: state.vault_epoch(),
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
        _ => return Err(denied("Unsupported confirmation operation")),
    };
    Ok(ConfirmationPrompt {
        kind,
        locale,
        target: include_target.then(|| target.to_owned()),
        local_name: None,
        application: None,
        security_changes: None,
        confirmation_phrase: (kind == ConfirmationKind::VaultReset).then(|| "RESET".into()),
        requires_reauthentication,
    })
}

fn open_with_prompt(intent: &OpenWithIntent, locale: String) -> ConfirmationPrompt {
    ConfirmationPrompt {
        kind: if intent.executable {
            ConfirmationKind::ExecuteRemoteFile
        } else {
            ConfirmationKind::OpenWithApplication
        },
        locale,
        target: Some(intent.remote_path.clone()),
        local_name: intent.renamed_local_name().map(str::to_owned),
        application: intent
            .application
            .as_ref()
            .map(|path| crate::local_fs::local_open::shell_path(path)),
        security_changes: None,
        confirmation_phrase: None,
        requires_reauthentication: false,
    }
}

fn weakening_prompt(
    weakening: Weakening,
    locale: String,
    requires_reauthentication: bool,
) -> ConfirmationPrompt {
    ConfirmationPrompt {
        kind: ConfirmationKind::WeakenSecuritySettings,
        locale,
        target: None,
        local_name: None,
        application: None,
        security_changes: Some(weakening),
        confirmation_phrase: None,
        requires_reauthentication,
    }
}

/// Parses the security part of a settings patch the renderer wants applied.
pub fn security_patch_from_request(target: &str) -> CommandResult<JsonMap> {
    let patch: JsonMap =
        serde_json::from_str(target).map_err(|_| denied("Invalid security settings request"))?;
    if patch
        .keys()
        .any(|key| !security_policy::SECURITY_KEYS.contains(&key.as_str()))
    {
        return Err(denied("Invalid security settings request"));
    }
    crate::store::validate_settings(&patch, false)
        .map_err(|issue| CommandError::new(ErrorCode::InvalidInput, issue))?;
    Ok(patch)
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
    approved_paths: State<'_, ApprovedLocalPaths>,
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
        "settings_set_security",
    ];
    if window.label() != "main" || !ALLOWED.contains(&operation.as_str()) {
        return Err(denied(
            "Sensitive operation is not permitted for this window",
        ));
    }
    let open_with = if operation == "open_with_start" {
        Some(OpenWithIntent::from_request(&target, &approved_paths)?)
    } else {
        None
    };
    let security_patch = if operation == "settings_set_security" {
        Some(security_patch_from_request(&target)?)
    } else {
        None
    };
    let target = match (&open_with, &security_patch) {
        (Some(intent), _) => intent.grant_target(),
        (_, Some(patch)) => security_policy::grant_target(patch),
        _ => normalized_target(&operation, &target)?,
    };
    let settings = store.get_settings().await;
    let weakening = security_patch
        .as_ref()
        .map(|patch| security_policy::weakening(&settings, patch))
        .filter(|weakening| !weakening.is_empty());
    let confirmations_enabled = settings
        .get("showSecurityConfirmations")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let requires_reauthentication = vault.is_configured()
        && (matches!(
            operation.as_str(),
            "sites_reveal_secret" | "settings_reveal_proxy_password"
        ) || weakening.is_some());
    // A program the user has not chosen before; approving the prompt trusts it.
    let mut untrusted_application = None;
    if let Some(application) = open_with
        .as_ref()
        .and_then(|intent| intent.application.as_ref())
        && !store.is_trusted_application(application).await
    {
        untrusted_application = Some(application.clone());
    }
    let required = match &open_with {
        Some(intent) => open_with_requires_confirmation(intent, untrusted_application.is_none()),
        None if security_patch.is_some() => weakening.is_some(),
        None => requires_confirmation(&operation),
    };
    if !should_prompt(
        &operation,
        required,
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
    let prompt = match (&open_with, weakening) {
        (Some(intent), _) => open_with_prompt(intent, locale),
        (None, Some(weakening)) => weakening_prompt(weakening, locale, requires_reauthentication),
        (None, None) => {
            confirmation_prompt(&operation, &target, locale, requires_reauthentication)?
        }
    };
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
    if let Some(application) = untrusted_application
        && let Err(error) = store.trust_application(&application).await
    {
        log::warn!("Could not remember the approved Open with program: {error:#}");
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
        || grant.vault_epoch != state.vault_epoch()
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
