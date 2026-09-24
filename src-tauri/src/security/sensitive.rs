use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::local_open::ApprovedLocalPaths;
use crate::security::credential_scope::{
    SecretTransfer, is_site_kind, proxy_transfer, site_request_transfer, site_save_target,
    site_save_transfer,
};
use crate::security::open_with_intent::OpenWithIntent;
use crate::security::security_policy::{self, Weakening};
use crate::security::vault::Vault;
use crate::security::vault_guard::VaultGuard;
use crate::store::{JsonMap, Store};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, State, WindowEvent};
use zeroize::Zeroize;

const TOKEN_TTL: Duration = Duration::from_secs(30);
/// How many unused grants may exist at once.
///
/// A grant expires, but nothing stopped the renderer asking for one after
/// another and keeping every live one in memory. The window that confirms
/// them is modal enough that a person cannot produce more than a handful.
const MAX_GRANTS: usize = 32;
/// How many confirmation windows may be open at once. Each one is a real
/// OS window, so this is a bound on what the renderer can put on screen.
const MAX_PENDING_CONFIRMATIONS: usize = 4;

/// How long a confirmed change to the protected settings stays usable.
///
/// The settings dialog asks for this grant the moment the user relaxes a
/// protection, not when they press Save, so the grant has to outlive the rest
/// of their visit to the dialog. It stays bound to the same window, the same
/// patch and the same vault session as any other, and is still one-time.
const SETTINGS_TOKEN_TTL: Duration = Duration::from_secs(15 * 60);

fn token_ttl(operation: &str) -> Duration {
    if operation == "settings_set_security" {
        SETTINGS_TOKEN_TTL
    } else {
        TOKEN_TTL
    }
}

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
    UseSystemProtection,
    TransferSecret,
    TrustHostKey,
}

/// The two fingerprints a host-key decision is about.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyFingerprints {
    /// The pinned fingerprint, absent on a first connection.
    pub expected: Option<String>,
    pub actual: String,
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
    /// A saved password that would be kept for a new recipient.
    secret_transfer: Option<SecretTransfer>,
    /// The SSH host key the user is being asked to trust.
    host_key: Option<HostKeyFingerprints>,
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
            | "vault_use_system_protection"
            | "fs_execute_path"
            | "session_trust_host_key"
    )
}

/// Launching a program or script needs a confirmation, and so does handing
/// even a document to a program the user has not chosen before.
fn open_with_requires_confirmation(intent: &OpenWithIntent, application_trusted: bool) -> bool {
    intent.executable || (intent.application.is_some() && !application_trusted)
}

/// Removing or downgrading the vault, and weakening the settings that
/// decide about prompts, are confirmed whatever those settings say.
fn should_show_confirmation(operation: &str, required: bool, enabled: bool) -> bool {
    required
        && (matches!(
            operation,
            "vault_reset"
                | "vault_use_system_protection"
                | "settings_set_security"
                | "sites_save"
                | "session_trust_host_key"
        ) || enabled)
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
    let ttl = token_ttl(&operation);
    let token = uuid::Uuid::new_v4().to_string();
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| denied("Authorization state unavailable"))?;
    grants.retain(|_, grant| grant.expires > Instant::now());
    if grants.len() >= MAX_GRANTS {
        return Err(CommandError::new(
            ErrorCode::ResourceLimit,
            "Too many authorizations are waiting to be used",
        ));
    }
    grants.insert(
        token.clone(),
        Grant {
            window: window.label().to_owned(),
            operation,
            target,
            expires: Instant::now() + ttl,
            vault_epoch: state.vault_epoch(),
        },
    );
    Ok(AuthorizationToken { token })
}

/// The language the confirmation window is written in.
///
/// The main window passes the language it is showing right now, which is not
/// always the saved one: the settings dialog previews a language change long
/// before it is saved, and a confirmation raised from that dialog has to speak
/// the language the user is reading. Only the shape of a language tag is
/// trusted from there; the window itself falls back to English for a tag it
/// has no translations for.
fn prompt_locale(requested: Option<&str>, settings: &JsonMap) -> String {
    let well_formed = |tag: &&str| {
        (2..=16).contains(&tag.len())
            && tag
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    };
    requested
        .filter(well_formed)
        .or_else(|| {
            settings
                .get("language")
                .and_then(Value::as_str)
                .filter(well_formed)
        })
        .unwrap_or("en")
        .to_owned()
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
        "vault_use_system_protection" => (ConfirmationKind::UseSystemProtection, false),
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
        secret_transfer: None,
        host_key: None,
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
        secret_transfer: None,
        host_key: None,
        confirmation_phrase: None,
        requires_reauthentication: false,
    }
}

/// The server whose host key the user is being asked to trust. The grant
/// is bound to all four values, so approving one replacement cannot be
/// spent on another server or on a different pair of keys.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostKeyRequest {
    pub host: String,
    pub port: u16,
    /// The pinned fingerprint, absent on a first connection.
    #[serde(default)]
    pub expected: Option<String>,
    pub actual: String,
}

pub fn host_key_from_request(target: &str) -> CommandResult<HostKeyRequest> {
    let request: HostKeyRequest =
        serde_json::from_str(target).map_err(|_| denied("Invalid host key request"))?;
    let sane = |value: &str| {
        !value.is_empty() && value.len() <= 128 && value.chars().all(|c| c.is_ascii_hexdigit())
    };
    if request.host.is_empty()
        || request.host.len() > 255
        || !sane(&request.actual)
        || request
            .expected
            .as_deref()
            .is_some_and(|value| !sane(value))
    {
        return Err(denied("Invalid host key request"));
    }
    Ok(request)
}

/// Parses a patch of protected settings. In an authorization request a new
/// proxy password is named by `true` rather than sent.
pub fn security_patch_from_request(target: &str) -> CommandResult<JsonMap> {
    let patch: JsonMap =
        serde_json::from_str(target).map_err(|_| denied("Invalid security settings request"))?;
    if patch
        .keys()
        .any(|key| !security_policy::PROTECTED_KEYS.contains(&key.as_str()))
    {
        return Err(denied("Invalid security settings request"));
    }
    let mut checked = patch.clone();
    if checked.get("proxyPassword").is_some_and(Value::is_boolean) {
        checked.remove("proxyPassword");
    }
    crate::store::validate_settings(&checked, true)
        .map_err(|issue| CommandError::new(ErrorCode::InvalidInput, issue))?;
    Ok(patch)
}

/// What an authorization request resolves to before anyone is asked.
struct Plan {
    /// The value the grant is bound to.
    target: String,
    /// Whether the operation itself calls for a confirmation.
    required: bool,
    /// The confirmation to show, when one may be needed.
    prompt: Option<ConfirmationPrompt>,
    /// A program the user starts trusting by approving the prompt.
    trusts_application: Option<std::path::PathBuf>,
}

fn plan_operation(
    operation: &str,
    target: &str,
    vault_configured: bool,
    locale: String,
) -> CommandResult<Plan> {
    let target = normalized_target(operation, target)?;
    let required = requires_confirmation(operation);
    let requires_reauthentication = vault_configured
        && matches!(
            operation,
            "sites_reveal_secret"
                | "settings_reveal_proxy_password"
                | "vault_use_system_protection"
        );
    let prompt = (required || requires_reauthentication)
        .then(|| confirmation_prompt(operation, &target, locale, requires_reauthentication))
        .transpose()?;
    Ok(Plan {
        target,
        required,
        prompt,
        trusts_application: None,
    })
}

async fn plan_open_with(
    store: &Store,
    approved_paths: &ApprovedLocalPaths,
    target: &str,
    locale: String,
) -> CommandResult<Plan> {
    let intent = OpenWithIntent::from_request(target, approved_paths)?;
    // A program the user has not chosen before; approving the prompt trusts it.
    let mut untrusted_application = None;
    if let Some(application) = intent.application.as_ref()
        && !store.is_trusted_application(application).await
    {
        untrusted_application = Some(application.clone());
    }
    Ok(Plan {
        target: intent.grant_target(),
        required: open_with_requires_confirmation(&intent, untrusted_application.is_none()),
        prompt: Some(open_with_prompt(&intent, locale)),
        trusts_application: untrusted_application,
    })
}

fn plan_protected_settings(
    settings: &JsonMap,
    vault_configured: bool,
    target: &str,
    locale: String,
) -> CommandResult<Plan> {
    let patch = security_patch_from_request(target)?;
    let weakening = security_policy::weakening(settings, &patch);
    let transfer = proxy_transfer(settings, &patch);
    let required = !weakening.is_empty() || transfer.is_some();
    let prompt = ConfirmationPrompt {
        kind: if weakening.is_empty() {
            ConfirmationKind::TransferSecret
        } else {
            ConfirmationKind::WeakenSecuritySettings
        },
        locale,
        target: None,
        local_name: None,
        application: None,
        requires_reauthentication: vault_configured && !weakening.is_empty(),
        security_changes: (!weakening.is_empty()).then_some(weakening),
        secret_transfer: transfer,
        host_key: None,
        confirmation_phrase: None,
    };
    Ok(Plan {
        target: security_policy::grant_target(settings, &patch),
        required,
        prompt: Some(prompt),
        trusts_application: None,
    })
}

fn plan_host_key(target: &str, locale: String) -> CommandResult<Plan> {
    let request = host_key_from_request(target)?;
    Ok(Plan {
        prompt: Some(ConfirmationPrompt {
            kind: ConfirmationKind::TrustHostKey,
            locale,
            target: Some(format!("{}:{}", request.host, request.port)),
            local_name: None,
            application: None,
            security_changes: None,
            secret_transfer: None,
            host_key: Some(HostKeyFingerprints {
                expected: request.expected,
                actual: request.actual,
            }),
            confirmation_phrase: None,
            requires_reauthentication: false,
        }),
        target: target.to_owned(),
        required: true,
        trusts_application: None,
    })
}

async fn plan_site_save(store: &Store, target: &str, locale: String) -> CommandResult<Plan> {
    let input: JsonMap =
        serde_json::from_str(target).map_err(|_| denied("Invalid bookmark request"))?;
    // The request names a new password by `true` or `false` only; a sent
    // secret or a kind `sites_save` does not write is refused here as well
    // as at the save itself.
    if !is_site_kind(&input) || !matches!(input.get("password"), None | Some(Value::Bool(_))) {
        return Err(denied("Invalid bookmark request"));
    }
    let transfer = match input.get("id").and_then(Value::as_str) {
        Some(id) => site_request_transfer(store.saved_site_credentials(id).await.as_ref(), &input),
        None => None,
    };
    Ok(Plan {
        target: site_save_target(&input, transfer.as_ref()),
        required: transfer.is_some(),
        prompt: Some(ConfirmationPrompt {
            kind: ConfirmationKind::TransferSecret,
            locale,
            target: None,
            local_name: None,
            application: None,
            security_changes: None,
            secret_transfer: transfer,
            host_key: None,
            confirmation_phrase: None,
            requires_reauthentication: false,
        }),
        trusts_application: None,
    })
}

/// The password move saving the bookmark `input` makes against the bookmark
/// as stored now.
pub async fn site_save_transfer_for(store: &Store, input: &JsonMap) -> Option<SecretTransfer> {
    let id = input.get("id").and_then(Value::as_str)?;
    let stored = store.saved_site_credentials(id).await;
    site_save_transfer(stored.as_ref(), input)
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
        permit
            .finish(if verified {
                crate::security::vault_guard::AttemptOutcome::Accepted
            } else {
                crate::security::vault_guard::AttemptOutcome::Rejected
            })
            .await;
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
// A Tauri command takes its managed state as parameters, so four of these are
// injected rather than passed by the caller, which sends only three.
#[allow(clippy::too_many_arguments)]
pub async fn authorize_sensitive(
    window: tauri::WebviewWindow,
    state: State<'_, AuthorizationState>,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    approved_paths: State<'_, ApprovedLocalPaths>,
    operation: String,
    target: String,
    locale: Option<String>,
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
        "vault_use_system_protection",
        "sites_save",
        "session_trust_host_key",
    ];
    if window.label() != "main" || !ALLOWED.contains(&operation.as_str()) {
        return Err(denied(
            "Sensitive operation is not permitted for this window",
        ));
    }
    let settings = store.get_settings().await;
    let confirmations_enabled = settings
        .get(security_policy::CONFIRMATIONS)
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let locale = prompt_locale(locale.as_deref(), &settings);
    let plan = match operation.as_str() {
        "open_with_start" => plan_open_with(&store, &approved_paths, &target, locale).await?,
        "settings_set_security" => {
            plan_protected_settings(&settings, vault.is_configured(), &target, locale)?
        }
        "sites_save" => plan_site_save(&store, &target, locale).await?,
        "session_trust_host_key" => plan_host_key(&target, locale)?,
        _ => plan_operation(&operation, &target, vault.is_configured(), locale)?,
    };
    let requires_reauthentication = plan
        .prompt
        .as_ref()
        .is_some_and(|prompt| prompt.requires_reauthentication);
    if !should_prompt(
        &operation,
        plan.required,
        confirmations_enabled,
        requires_reauthentication,
    ) {
        return issue_token(&state, &window, operation, plan.target);
    }
    let Plan {
        target,
        prompt,
        trusts_application,
        ..
    } = plan;
    let prompt = prompt.ok_or_else(|| denied("Unsupported confirmation operation"))?;
    let app = window.app_handle().clone();
    let request_id = uuid::Uuid::new_v4().to_string();
    let confirmation_label = format!("security-confirmation-{request_id}");
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| denied("Authorization state unavailable"))?;
        // Refuse before the window is built rather than after: each pending
        // confirmation is a real OS window, and the renderer decides how
        // many to ask for.
        if pending.len() >= MAX_PENDING_CONFIRMATIONS {
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                "Too many security confirmations are already open",
            ));
        }
        pending.insert(
            request_id.clone(),
            PendingConfirmation {
                window: confirmation_label.clone(),
                prompt: prompt.clone(),
                response: tx,
            },
        );
    }
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
    if let Some(application) = trusts_application
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
