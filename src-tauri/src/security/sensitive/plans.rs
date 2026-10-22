//! What a grant asks of the user: for each operation, the target it is bound
//! to, whether it needs a confirmation, and the prompt that confirmation shows.
use super::*;

pub(super) fn confirmation_prompt(
    operation: SensitiveOperation,
    target: &str,
    locale: String,
    requires_reauthentication: bool,
) -> CommandResult<ConfirmationPrompt> {
    let (kind, include_target) = match operation {
        Op::SitesRevealSecret => (ConfirmationKind::RevealSiteSecret, false),
        Op::SettingsRevealProxyPassword => (ConfirmationKind::RevealProxyPassword, false),
        Op::VaultReset => (ConfirmationKind::VaultReset, false),
        Op::VaultUseSystemProtection => (ConfirmationKind::UseSystemProtection, false),
        Op::FsExecutePath => (ConfirmationKind::ExecuteLocalFile, true),
        Op::AppExportSettings => (ConfirmationKind::ExportSecrets, false),
        _ => return Err(denied("Unsupported confirmation operation")),
    };
    Ok(ConfirmationPrompt {
        kind,
        locale,
        target: include_target.then(|| crate::local_fs::local_open::shell_path(Path::new(target))),
        local_name: None,
        application: None,
        security_changes: None,
        secret_transfer: None,
        host_key: None,
        confirmation_phrase: (kind == ConfirmationKind::VaultReset).then(|| "RESET".into()),
        requires_reauthentication,
        system_unlock: false,
    })
}

pub(super) fn open_with_prompt(intent: &OpenWithIntent, locale: String) -> ConfirmationPrompt {
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
        system_unlock: false,
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
pub(super) struct Plan {
    /// The value the grant is bound to.
    pub(super) target: String,
    /// Whether the operation itself calls for a confirmation.
    pub(super) required: bool,
    /// The confirmation to show, when one may be needed.
    pub(super) prompt: Option<ConfirmationPrompt>,
    /// A program the user starts trusting by approving the prompt.
    pub(super) trusts_application: Option<std::path::PathBuf>,
}

pub(super) fn plan_operation(
    operation: SensitiveOperation,
    target: &str,
    vault_configured: bool,
    vault_damaged: bool,
    locale: String,
) -> CommandResult<Plan> {
    let target = normalized_target(operation, target)?;
    // An export that carries the saved passwords has a grant of its own,
    // asked for as a saved password is shown.
    let exports_secrets = operation == Op::AppExportSettings && target == "secrets";
    if operation == Op::AppExportSettings && !exports_secrets && target != "native-dialog" {
        return Err(denied("Invalid export request"));
    }
    let required = requires_confirmation(operation) || exports_secrets;
    let requires_reauthentication = vault_configured
        && (exports_secrets
            || matches!(
                operation,
                Op::SitesRevealSecret
                    | Op::SettingsRevealProxyPassword
                    | Op::VaultUseSystemProtection
            ));
    let mut prompt = (required || requires_reauthentication)
        .then(|| confirmation_prompt(operation, &target, locale, requires_reauthentication))
        .transpose()?;
    // A damaged vault is set aside, not deleted, and says so.
    if operation == Op::VaultReset
        && vault_damaged
        && let Some(prompt) = prompt.as_mut()
    {
        prompt.kind = ConfirmationKind::VaultStartOver;
    }
    Ok(Plan {
        target,
        required,
        prompt,
        trusts_application: None,
    })
}

pub(super) async fn plan_open_with(
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

pub(super) fn plan_protected_settings(
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
        system_unlock: false,
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

pub(super) fn plan_host_key(target: &str, locale: String) -> CommandResult<Plan> {
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
            system_unlock: false,
        }),
        target: target.to_owned(),
        required: true,
        trusts_application: None,
    })
}

/// Moving a password reads it from the vault. Refused before the prompt while
/// the vault is locked, so the unlock comes first and the question only once.
pub(super) fn unlock_before_moving_password(
    moves_password: bool,
    vault_locked: bool,
) -> CommandResult<()> {
    if moves_password && vault_locked {
        return Err(CommandError::new(ErrorCode::VaultLocked, "Vault is locked"));
    }
    Ok(())
}

pub(super) async fn plan_site_save(
    store: &Store,
    target: &str,
    locale: String,
) -> CommandResult<Plan> {
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
            system_unlock: false,
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
