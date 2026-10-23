use super::*;

fn grant(
    state: &AuthorizationState,
    token: &str,
    operation: SensitiveOperation,
    target: &str,
    expires: Instant,
) {
    state.grants.lock().unwrap().insert(
        token.into(),
        Grant {
            window: "main".into(),
            operation,
            target: target.into(),
            expires,
            vault_epoch: state.vault_epoch(),
        },
    );
}

#[test]
fn missing_token_is_permission_denied() {
    let error = consume_for_label(
        "main",
        &AuthorizationState::default(),
        "missing",
        Op::VaultReset,
        "vault",
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::PermissionDenied);
}

#[test]
fn token_is_bound_to_window_operation_and_target_and_is_one_time() {
    for (window, operation, target) in [
        ("other", Op::VaultReset, "vault"),
        ("main", Op::FsOpenDocument, "vault"),
        ("main", Op::VaultReset, "other"),
    ] {
        let state = AuthorizationState::default();
        grant(
            &state,
            "token",
            Op::VaultReset,
            "vault",
            Instant::now() + TOKEN_TTL,
        );
        assert!(consume_for_label(window, &state, "token", operation, target).is_err());
    }
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        Op::VaultReset,
        "vault",
        Instant::now() + TOKEN_TTL,
    );
    assert!(consume_for_label("main", &state, "token", Op::VaultReset, "vault").is_ok());
    assert!(consume_for_label("main", &state, "token", Op::VaultReset, "vault").is_err());
}

#[test]
fn expired_token_is_permission_denied() {
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        Op::VaultReset,
        "vault",
        Instant::now() - Duration::from_secs(1),
    );
    assert!(consume_for_label("main", &state, "token", Op::VaultReset, "vault").is_err());
}

#[test]
fn secret_confirmation_does_not_expose_internal_identifiers() {
    let prompt = confirmation_prompt(
        Op::SitesRevealSecret,
        "7f2d1eb0-cc22-4135-b186-2b0018326fdd:password",
        "ru".into(),
        true,
    )
    .unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::RevealSiteSecret);
    assert_eq!(prompt.locale, "ru");
    assert_eq!(prompt.target, None);
    assert!(prompt.requires_reauthentication);
}

#[test]
fn confirmation_is_reserved_for_secrets_reset_and_executables() {
    for operation in [
        Op::SitesRevealSecret,
        Op::SettingsRevealProxyPassword,
        Op::VaultReset,
        Op::FsExecutePath,
    ] {
        assert!(requires_confirmation(operation));
    }

    for operation in [
        Op::FsDelete,
        Op::FsRevealPath,
        Op::FsOpenDocument,
        Op::AppExportSettings,
        Op::AppImportPreview,
        Op::AppImportApply,
        Op::AppImportDiscard,
    ] {
        assert!(!requires_confirmation(operation));
    }
}

#[test]
fn an_export_names_whether_it_carries_the_saved_passwords() {
    let plain = plan_operation(
        Op::AppExportSettings,
        "native-dialog",
        true,
        false,
        "en".into(),
    )
    .unwrap();
    assert!(!plain.required);
    assert!(plain.prompt.is_none());
    assert_eq!(plain.target, "native-dialog");
    // The passwords are asked for as one saved password is shown: confirmed,
    // and with a vault behind the master password or Windows Hello.
    for vault_configured in [true, false] {
        let plan = plan_operation(
            Op::AppExportSettings,
            "secrets",
            vault_configured,
            false,
            "en".into(),
        )
        .unwrap();
        assert!(plan.required);
        assert_eq!(plan.target, "secrets");
        let prompt = plan.prompt.unwrap();
        assert_eq!(prompt.kind, ConfirmationKind::ExportSecrets);
        assert_eq!(prompt.requires_reauthentication, vault_configured);
    }
    assert!(plan_operation(Op::AppExportSettings, "anything", true, false, "en".into()).is_err());
}

#[test]
fn a_damaged_vault_is_started_over_not_reset() {
    let kind = |damaged| {
        plan_operation(Op::VaultReset, "", false, damaged, "en".into())
            .unwrap()
            .prompt
            .unwrap()
            .kind
    };
    assert_eq!(kind(false), ConfirmationKind::VaultReset);
    assert_eq!(kind(true), ConfirmationKind::VaultStartOver);
}

fn open_with(remote_path: &str, application: Option<&str>) -> OpenWithIntent {
    let request = serde_json::json!({
        "connectionId": "c1",
        "remotePath": remote_path,
        "application": application,
    });
    OpenWithIntent::from_request(&request.to_string(), &ApprovedLocalPaths::default()).unwrap()
}

#[test]
fn open_with_confirms_scripts_by_the_name_they_are_saved_under() {
    for remote in [
        "/remote/tool.ps1",
        "/remote/report.cmd.",
        "/remote/report.cmd ",
        "/remote/report.hta...",
        "/remote/REPORT.Ps1.",
    ] {
        let intent = open_with(remote, None);
        assert!(open_with_requires_confirmation(&intent, true), "{remote:?}");
        let prompt = open_with_prompt(&intent, "en".into());
        assert_eq!(prompt.kind, ConfirmationKind::ExecuteRemoteFile);
        assert_eq!(prompt.target.as_deref(), Some(remote));
    }
    let prompt = open_with_prompt(&open_with("/remote/report.cmd.", None), "en".into());
    assert_eq!(prompt.local_name.as_deref(), Some("report.cmd"));
    assert!(!open_with_requires_confirmation(
        &open_with("/remote/document.pdf", None),
        true
    ));
}

#[test]
fn open_with_confirms_a_program_the_user_has_not_chosen() {
    let program = std::env::current_exe().unwrap();
    let intent = open_with("/remote/notes.txt", program.to_str());
    assert!(open_with_requires_confirmation(&intent, false));
    assert!(!open_with_requires_confirmation(&intent, true));
    let prompt = open_with_prompt(&intent, "en".into());
    assert_eq!(prompt.kind, ConfirmationKind::OpenWithApplication);
    assert_eq!(
        prompt.application.as_deref(),
        Some(
            crate::local_fs::local_open::shell_path(&std::fs::canonicalize(program).unwrap())
                .as_str()
        )
    );
    assert!(!prompt.application.unwrap().starts_with(r"\\?\"));
}

#[test]
fn open_with_grant_rejects_another_connection_program_or_path() {
    let program = std::env::current_exe().unwrap();
    let approved = open_with("/remote/notes.txt", None);
    let other_connection = OpenWithIntent::resolve(
        "c2",
        "/remote/notes.txt",
        None,
        &ApprovedLocalPaths::default(),
    )
    .unwrap();
    for other in [
        other_connection,
        open_with("/remote/notes.txt", program.to_str()),
        open_with("/remote/notes.txt.", None),
    ] {
        let state = AuthorizationState::default();
        grant(
            &state,
            "token",
            Op::OpenWithStart,
            &approved.grant_target(),
            Instant::now() + TOKEN_TTL,
        );
        assert!(
            consume_for_label(
                "main",
                &state,
                "token",
                Op::OpenWithStart,
                &other.grant_target()
            )
            .is_err()
        );
    }
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        Op::OpenWithStart,
        &approved.grant_target(),
        Instant::now() + TOKEN_TTL,
    );
    assert!(
        consume_for_label(
            "main",
            &state,
            "token",
            Op::OpenWithStart,
            &approved.grant_target()
        )
        .is_ok()
    );
}

#[test]
fn vault_reset_requires_typed_confirmation() {
    let prompt = confirmation_prompt(Op::VaultReset, "vault", "en".into(), false).unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::VaultReset);
    assert_eq!(prompt.confirmation_phrase.as_deref(), Some("RESET"));
    assert_eq!(prompt.target, None);
}

#[test]
fn executable_confirmation_exposes_only_the_canonical_target() {
    let prompt =
        confirmation_prompt(Op::FsExecutePath, "C:\\safe\\tool.exe", "en".into(), false).unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::ExecuteLocalFile);
    assert_eq!(prompt.target.as_deref(), Some("C:\\safe\\tool.exe"));
}

#[test]
fn executable_confirmation_shows_the_path_without_the_verbatim_prefix() {
    let prompt = confirmation_prompt(
        Op::FsExecutePath,
        "\\\\?\\C:\\safe\\tool.exe",
        "en".into(),
        false,
    )
    .unwrap();
    assert_eq!(prompt.target.as_deref(), Some("C:\\safe\\tool.exe"));
}

#[test]
fn disabled_confirmations_never_suppress_vault_reset() {
    assert!(should_show_confirmation(Op::VaultReset, true, false));
    assert!(!should_show_confirmation(
        Op::SitesRevealSecret,
        true,
        false
    ));
    assert!(!should_show_confirmation(Op::FsExecutePath, true, false));
    assert!(should_show_confirmation(Op::FsExecutePath, true, true));
    assert!(!should_show_confirmation(Op::FsOpenDocument, false, true));
}

#[test]
fn enhanced_secret_reveal_always_prompts_for_reauthentication() {
    for operation in [Op::SitesRevealSecret, Op::SettingsRevealProxyPassword] {
        assert!(should_prompt(operation, true, false, true));
        assert!(should_prompt(operation, true, true, true));
    }
    assert!(!should_prompt(Op::SitesRevealSecret, true, false, false));
}

#[test]
fn relaxing_security_settings_is_confirmed_even_with_confirmations_off() {
    assert!(should_show_confirmation(
        Op::SettingsSetSecurity,
        true,
        false
    ));
    assert!(!should_show_confirmation(
        Op::SettingsSetSecurity,
        false,
        false
    ));
}

#[test]
fn security_requests_accept_only_valid_security_keys() {
    assert!(security_patch_from_request(r#"{"showSecurityConfirmations":false}"#).is_ok());
    assert!(security_patch_from_request(r#"{"vaultAutoLockMinutes":0}"#).is_ok());
    // The proxy's switch comes with its address: an emptied proxy is valid
    // only together with being switched off.
    assert!(security_patch_from_request(r#"{"proxyEnabled":false,"proxyHost":""}"#).is_ok());
    assert!(security_patch_from_request(r#"{"proxyEnabled":true,"proxyHost":""}"#).is_err());
    for request in [
        r#"{"theme":"dark"}"#,
        r#"{"showSecurityConfirmations":false,"proxyPasswordEnc":"AQID"}"#,
        r#"{"proxyPort":"not a port"}"#,
        r#"{"vaultAutoLockMinutes":999999}"#,
        "false",
    ] {
        assert!(security_patch_from_request(request).is_err(), "{request}");
    }
}

#[test]
fn weakening_prompt_lists_what_is_turned_off() {
    let plan = plan_protected_settings(
        &JsonMap::new(),
        true,
        r#"{"showSecurityConfirmations":false}"#,
        "en".into(),
    )
    .unwrap();
    assert!(plan.required);
    let prompt = plan.prompt.unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::WeakenSecuritySettings);
    assert!(prompt.requires_reauthentication);
    let value = serde_json::to_value(&prompt).unwrap();
    assert_eq!(
        value["securityChanges"]["showSecurityConfirmations"],
        serde_json::json!(false)
    );
}

#[test]
fn moving_the_proxy_password_is_confirmed_without_reauthentication() {
    let settings: JsonMap = serde_json::from_value(serde_json::json!({
        "proxyType": "socks5", "proxyHost": "p.example", "proxyPort": 1080,
        "proxyPasswordEnc": "AQID"
    }))
    .unwrap();
    let plan =
        plan_protected_settings(&settings, true, r#"{"proxyHost":"q.example"}"#, "en".into())
            .unwrap();
    assert!(plan.required);
    let prompt = plan.prompt.unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::TransferSecret);
    assert!(!prompt.requires_reauthentication);
    let transfer = prompt.secret_transfer.unwrap();
    assert!(transfer.from.contains("p.example") && transfer.to.contains("q.example"));

    let replaced = plan_protected_settings(
        &settings,
        true,
        r#"{"proxyHost":"q.example","proxyPassword":true}"#,
        "en".into(),
    )
    .unwrap();
    assert!(!replaced.required);
    assert!(should_show_confirmation(Op::SitesSave, true, false));
}

#[test]
fn a_policy_change_withdraws_unused_grants() {
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        Op::VaultReset,
        "vault",
        Instant::now() + TOKEN_TTL,
    );
    state.revoke_all();
    assert!(consume_for_label("main", &state, "token", Op::VaultReset, "vault").is_err());
}

#[tokio::test]
async fn locking_the_vault_withdraws_grants_issued_before() {
    let dir = std::env::temp_dir().join(format!("ftpeach-grants-{}", uuid::Uuid::new_v4()));
    let vault = Vault::new(dir);
    let state = AuthorizationState::new(vault.clone());
    let before = issue(&state, Op::VaultReset, Instant::now());
    vault.lock().await;
    let after = issue(&state, Op::VaultReset, Instant::now());
    assert!(consume_for_label("main", &state, &before, Op::VaultReset, "vault").is_err());
    assert!(consume_for_label("main", &state, &after, Op::VaultReset, "vault").is_ok());
}

#[test]
fn switching_off_enhanced_protection_is_always_confirmed() {
    assert!(requires_confirmation(Op::VaultUseSystemProtection));
    assert!(should_show_confirmation(
        Op::VaultUseSystemProtection,
        true,
        false
    ));
    let prompt =
        confirmation_prompt(Op::VaultUseSystemProtection, "vault", "en".into(), true).unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::UseSystemProtection);
    assert!(prompt.requires_reauthentication);
}

#[test]
fn the_prompt_follows_the_language_the_main_window_is_showing() {
    let saved: JsonMap = serde_json::from_value(serde_json::json!({ "language": "ru" })).unwrap();
    assert_eq!(prompt_locale(Some("de"), &saved), "de");
    assert_eq!(prompt_locale(Some("pt-BR"), &saved), "pt-BR");
    // Anything that is not shaped like a language tag falls back to the saved
    // language, and an empty settings map to English.
    for requested in [
        None,
        Some(""),
        Some("x"),
        Some("../../etc"),
        Some("a".repeat(64).as_str()),
    ] {
        assert_eq!(prompt_locale(requested, &saved), "ru", "{requested:?}");
        assert_eq!(
            prompt_locale(requested, &JsonMap::new()),
            "en",
            "{requested:?}"
        );
    }
}

#[test]
fn trusting_a_host_key_is_always_confirmed_for_exactly_the_keys_shown() {
    let shown = r#"{"host":"sftp.example","port":22,"expected":"aa11","actual":"bb22"}"#;
    assert!(requires_confirmation(Op::SessionTrustHostKey));
    // Turning confirmations off does not turn this one off.
    assert!(should_show_confirmation(
        Op::SessionTrustHostKey,
        true,
        false
    ));
    let plan = plan_host_key(shown, "en".into()).unwrap();
    assert!(plan.required);
    let prompt = plan.prompt.unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::TrustHostKey);
    assert_eq!(prompt.target.as_deref(), Some("sftp.example:22"));
    let keys = prompt.host_key.unwrap();
    assert_eq!(
        (keys.expected.as_deref(), keys.actual.as_str()),
        (Some("aa11"), "bb22")
    );

    // The grant covers the request the user saw, not another server or key.
    for other in [
        r#"{"host":"sftp.example","port":22,"expected":"aa11","actual":"cc33"}"#,
        r#"{"host":"sftp.example","port":2222,"expected":"aa11","actual":"bb22"}"#,
        r#"{"host":"other.example","port":22,"expected":"aa11","actual":"bb22"}"#,
        r#"{"host":"sftp.example","port":22,"actual":"bb22"}"#,
    ] {
        let state = AuthorizationState::default();
        grant(
            &state,
            "token",
            Op::SessionTrustHostKey,
            shown,
            Instant::now() + TOKEN_TTL,
        );
        assert!(
            consume_for_label("main", &state, "token", Op::SessionTrustHostKey, other).is_err(),
            "{other}"
        );
    }

    for malformed in [
        r#"{"host":"","port":22,"actual":"bb22"}"#,
        r#"{"host":"sftp.example","port":22,"actual":"not hex"}"#,
        r#"{"host":"sftp.example","port":22,"actual":""}"#,
    ] {
        assert!(
            plan_host_key(malformed, "en".into()).is_err(),
            "{malformed}"
        );
    }
}

#[tokio::test]
async fn a_bookmark_grant_covers_only_the_save_it_describes() {
    let dir = std::env::temp_dir().join(format!("ftpeach-site-grant-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(dir.clone());
    let site = |value: serde_json::Value| -> JsonMap { serde_json::from_value(value).unwrap() };
    store
        .save_site(site(serde_json::json!({
            "id": "s", "name": "S", "protocol": "ftp", "host": "a.example", "password": "grant-test-secret"
        })))
        .await
        .unwrap();

    // Asked with a new password, the move to b.example needs no prompt...
    let request = r#"{"id":"s","name":"S","protocol":"ftp","host":"b.example","password":true}"#;
    let plan = plan_site_save(&store, request, "en".into()).await.unwrap();
    assert!(!plan.required);
    // ...but a save sent `password: true` has no new password and would keep
    // the old one, so it is not the save that grant was issued for.
    let payload = site(serde_json::from_str(request).unwrap());
    let moved = site_save_transfer_for(&store, &payload).await;
    assert!(moved.is_some());
    assert_ne!(site_save_target(&payload, moved.as_ref()), plan.target);

    for invalid in [
        r#"{"id":"s","name":"S","kind":"folder","host":"b.example","password":false}"#,
        r#"{"id":"s","name":"S","kind":7,"host":"b.example","password":false}"#,
        r#"{"id":"s","name":"S","protocol":"ftp","host":"b.example","password":"sent"}"#,
    ] {
        assert!(
            plan_site_save(&store, invalid, "en".into()).await.is_err(),
            "{invalid}"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// A confirmation that asks for the master password opens a locked vault
/// with it. The windows hear of that unlock as of any other; a password that
/// is only checked, or refused, opens nothing and announces nothing.
#[tokio::test]
async fn a_confirmation_that_unlocks_the_vault_says_so_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::Listener;
    const PASSWORD: &str = "correct horse battery staple";
    let root = std::env::temp_dir().join(format!("ftpeach-confirm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let vault = Vault::new(root.clone());
    vault.setup(PASSWORD).await.unwrap();
    let store = Store::new_at(root.clone());
    let app = tauri::test::mock_app();
    app.manage(crate::security::auto_lock::AutoLock::default());
    let heard = std::sync::Arc::new(AtomicUsize::new(0));
    let sink = heard.clone();
    app.listen_any("vault:unlocked", move |_| {
        sink.fetch_add(1, Ordering::SeqCst);
    });

    assert!(
        reauthenticate(app.handle(), &vault, &store, PASSWORD)
            .await
            .is_ok()
    );
    vault.lock().await;
    let wrong = reauthenticate(app.handle(), &vault, &store, "wrong").await;
    assert!(crate::security::vault::is_refused(&wrong.unwrap_err()));
    assert_eq!(heard.load(Ordering::SeqCst), 0);

    assert!(
        reauthenticate(app.handle(), &vault, &store, PASSWORD)
            .await
            .is_ok()
    );
    assert!(vault.is_unlocked().await);
    assert_eq!(heard.load(Ordering::SeqCst), 1);

    // The right password over a vault that cannot be read is not refused.
    vault.lock().await;
    std::fs::write(root.join("vault.dat"), b"damaged").unwrap();
    let broken = reauthenticate(app.handle(), &vault, &store, PASSWORD).await;
    assert!(!crate::security::vault::is_refused(&broken.unwrap_err()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_password_move_asks_for_the_vault_before_the_confirmation() {
    let locked = unlock_before_moving_password(true, true).unwrap_err();
    assert_eq!(locked.code, ErrorCode::VaultLocked);
    assert!(unlock_before_moving_password(true, false).is_ok());
    assert!(unlock_before_moving_password(false, true).is_ok());
}

fn issue(state: &AuthorizationState, operation: SensitiveOperation, now: Instant) -> String {
    issue_token_for_label(state, "main", operation, "vault".into(), now)
        .unwrap()
        .token
}

#[test]
fn an_issued_grant_is_accepted_once_for_what_it_was_issued_for() {
    let state = AuthorizationState::default();
    let token = issue(&state, Op::VaultReset, Instant::now());
    assert!(consume_for_label("main", &state, &token, Op::VaultReset, "other").is_err());
    let token = issue(&state, Op::VaultReset, Instant::now());
    assert!(consume_for_label("main", &state, &token, Op::VaultReset, "vault").is_ok());
    assert!(consume_for_label("main", &state, &token, Op::VaultReset, "vault").is_err());
}

#[test]
fn a_grant_lives_as_long_as_its_operation_allows() {
    let now = Instant::now();
    for (operation, ttl) in [
        (Op::VaultReset, TOKEN_TTL),
        (Op::SitesRevealSecret, TOKEN_TTL),
        (Op::SettingsSetSecurity, SETTINGS_TOKEN_TTL),
    ] {
        let state = AuthorizationState::default();
        let token = issue(&state, operation, now);
        let expires = state.grants.lock().unwrap()[&token].expires;
        assert_eq!(expires, now + ttl, "{operation:?} grant lifetime");
    }
}

#[test]
fn grants_are_capped_until_old_ones_expire() {
    let state = AuthorizationState::default();
    let now = Instant::now();
    for _ in 0..MAX_GRANTS {
        issue(&state, Op::VaultReset, now);
    }
    let error = issue_token_for_label(&state, "main", Op::VaultReset, "vault".into(), now)
        .err()
        .expect("one grant past the cap");
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    issue(&state, Op::VaultReset, now + TOKEN_TTL);
    assert_eq!(
        state.grants.lock().unwrap().len(),
        1,
        "expired grants make room"
    );
}

fn waiting(
    state: &AuthorizationState,
    request_id: &str,
    window: &str,
) -> tokio::sync::oneshot::Receiver<bool> {
    try_waiting(state, request_id, window).unwrap()
}

fn try_waiting(
    state: &AuthorizationState,
    request_id: &str,
    window: &str,
) -> CommandResult<tokio::sync::oneshot::Receiver<bool>> {
    let (response, answer) = tokio::sync::oneshot::channel();
    add_pending(
        state,
        request_id,
        PendingConfirmation {
            window: window.into(),
            prompt: confirmation_prompt(Op::VaultReset, "vault", "en".into(), false).unwrap(),
            response,
        },
    )?;
    Ok(answer)
}

#[test]
fn no_more_than_four_confirmations_wait_at_once() {
    let state = AuthorizationState::default();
    let _answers: Vec<_> = (0..MAX_PENDING_CONFIRMATIONS)
        .map(|n| {
            waiting(
                &state,
                &format!("request-{n}"),
                &format!("confirmation-{n}"),
            )
        })
        .collect();
    let error = try_waiting(&state, "one-more", "confirmation-more")
        .expect_err("a confirmation past the cap is refused");
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    reject_pending(&state, "request-0");
    assert!(
        try_waiting(&state, "one-more", "confirmation-more").is_ok(),
        "an answered confirmation makes room"
    );
}

#[test]
fn a_confirmation_is_read_only_by_the_window_built_for_it() {
    let state = AuthorizationState::default();
    let _answer = waiting(&state, "request", "confirmation-a");
    for (window, request) in [
        ("main", "request"),
        ("confirmation-b", "request"),
        ("confirmation-a", "another"),
    ] {
        let error = pending_prompt(&state, window, request)
            .err()
            .unwrap_or_else(|| panic!("{window} read {request}"));
        assert_eq!(error.code, ErrorCode::PermissionDenied);
    }
    let prompt = pending_prompt(&state, "confirmation-a", "request").unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::VaultReset);
}

#[test]
fn a_rejected_confirmation_answers_no_and_is_forgotten() {
    let state = AuthorizationState::default();
    let mut answer = waiting(&state, "request", "confirmation");
    reject_pending(&state, "request");
    assert_eq!(answer.try_recv(), Ok(false), "the waiting request hears no");
    assert!(
        state.pending.lock().unwrap().is_empty(),
        "a rejected request is forgotten"
    );
    reject_pending(&state, "request");
}

#[test]
fn an_operation_is_named_by_its_command_and_nothing_else_parses() {
    for operation in SensitiveOperation::ALL {
        assert_eq!(SensitiveOperation::parse(operation.name()), Some(operation));
    }
    assert_eq!(SensitiveOperation::parse("sites_list"), None);
    assert_eq!(SensitiveOperation::parse(""), None);
}

#[test]
fn every_operation_is_a_command_of_the_sensitive_plugin() {
    let build = include_str!("../../build.rs");
    let manifest = &build[build.find("SENSITIVE_COMMANDS").unwrap()..];
    let manifest = &manifest[..manifest.find("];").unwrap()];
    for operation in SensitiveOperation::ALL {
        let name = operation.name();
        assert!(manifest.contains(&format!("\"{name}\"")), "{name}");
    }
}
