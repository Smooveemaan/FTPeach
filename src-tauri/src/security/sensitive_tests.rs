use super::*;

fn grant(state: &AuthorizationState, token: &str, operation: &str, target: &str, expires: Instant) {
    state.grants.lock().unwrap().insert(
        token.into(),
        Grant {
            window: "main".into(),
            operation: operation.into(),
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
        "vault_reset",
        "vault",
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::PermissionDenied);
}

#[test]
fn token_is_bound_to_window_operation_and_target_and_is_one_time() {
    for (window, operation, target) in [
        ("other", "vault_reset", "vault"),
        ("main", "fs_open_document", "vault"),
        ("main", "vault_reset", "other"),
    ] {
        let state = AuthorizationState::default();
        grant(
            &state,
            "token",
            "vault_reset",
            "vault",
            Instant::now() + TOKEN_TTL,
        );
        assert!(consume_for_label(window, &state, "token", operation, target).is_err());
    }
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        "vault_reset",
        "vault",
        Instant::now() + TOKEN_TTL,
    );
    assert!(consume_for_label("main", &state, "token", "vault_reset", "vault").is_ok());
    assert!(consume_for_label("main", &state, "token", "vault_reset", "vault").is_err());
}

#[test]
fn expired_token_is_permission_denied() {
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        "vault_reset",
        "vault",
        Instant::now() - Duration::from_secs(1),
    );
    assert!(consume_for_label("main", &state, "token", "vault_reset", "vault").is_err());
}

#[test]
fn secret_confirmation_does_not_expose_internal_identifiers() {
    let prompt = confirmation_prompt(
        "sites_reveal_secret",
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
        "sites_reveal_secret",
        "settings_reveal_proxy_password",
        "vault_reset",
        "fs_execute_path",
    ] {
        assert!(requires_confirmation(operation));
    }

    for operation in [
        "fs_delete",
        "fs_reveal_path",
        "fs_open_document",
        "app_export_settings",
        "app_import_settings",
    ] {
        assert!(!requires_confirmation(operation));
    }
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
            "open_with_start",
            &approved.grant_target(),
            Instant::now() + TOKEN_TTL,
        );
        assert!(
            consume_for_label(
                "main",
                &state,
                "token",
                "open_with_start",
                &other.grant_target()
            )
            .is_err()
        );
    }
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        "open_with_start",
        &approved.grant_target(),
        Instant::now() + TOKEN_TTL,
    );
    assert!(
        consume_for_label(
            "main",
            &state,
            "token",
            "open_with_start",
            &approved.grant_target()
        )
        .is_ok()
    );
}

#[test]
fn vault_reset_requires_typed_confirmation() {
    let prompt = confirmation_prompt("vault_reset", "vault", "en".into(), false).unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::VaultReset);
    assert_eq!(prompt.confirmation_phrase.as_deref(), Some("RESET"));
    assert_eq!(prompt.target, None);
}

#[test]
fn executable_confirmation_exposes_only_the_canonical_target() {
    let prompt =
        confirmation_prompt("fs_execute_path", "C:\\safe\\tool.exe", "en".into(), false).unwrap();
    assert_eq!(prompt.kind, ConfirmationKind::ExecuteLocalFile);
    assert_eq!(prompt.target.as_deref(), Some("C:\\safe\\tool.exe"));
}

#[test]
fn disabled_confirmations_never_suppress_vault_reset() {
    assert!(should_show_confirmation("vault_reset", true, false));
    assert!(!should_show_confirmation(
        "sites_reveal_secret",
        true,
        false
    ));
    assert!(!should_show_confirmation("fs_execute_path", true, false));
    assert!(should_show_confirmation("fs_execute_path", true, true));
    assert!(!should_show_confirmation("fs_open_document", false, true));
}

#[test]
fn enhanced_secret_reveal_always_prompts_for_reauthentication() {
    for operation in ["sites_reveal_secret", "settings_reveal_proxy_password"] {
        assert!(should_prompt(operation, true, false, true));
        assert!(should_prompt(operation, true, true, true));
    }
    assert!(!should_prompt("sites_reveal_secret", true, false, false));
}

#[test]
fn relaxing_security_settings_is_confirmed_even_with_confirmations_off() {
    assert!(should_show_confirmation(
        "settings_set_security",
        true,
        false
    ));
    assert!(!should_show_confirmation(
        "settings_set_security",
        false,
        false
    ));
}

#[test]
fn security_requests_accept_only_valid_security_keys() {
    assert!(security_patch_from_request(r#"{"showSecurityConfirmations":false}"#).is_ok());
    assert!(security_patch_from_request(r#"{"vaultAutoLockMinutes":0}"#).is_ok());
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
    assert!(should_show_confirmation("sites_save", true, false));
}

#[test]
fn a_policy_change_withdraws_unused_grants() {
    let state = AuthorizationState::default();
    grant(
        &state,
        "token",
        "vault_reset",
        "vault",
        Instant::now() + TOKEN_TTL,
    );
    state.revoke_all();
    assert!(consume_for_label("main", &state, "token", "vault_reset", "vault").is_err());
}

#[tokio::test]
async fn locking_the_vault_withdraws_grants_issued_before() {
    let dir = std::env::temp_dir().join(format!("ftpeach-grants-{}", uuid::Uuid::new_v4()));
    let vault = Vault::new(dir);
    let state = AuthorizationState::new(vault.clone());
    grant(
        &state,
        "before",
        "vault_reset",
        "vault",
        Instant::now() + TOKEN_TTL,
    );
    vault.lock().await;
    grant(
        &state,
        "after",
        "vault_reset",
        "vault",
        Instant::now() + TOKEN_TTL,
    );
    assert!(consume_for_label("main", &state, "before", "vault_reset", "vault").is_err());
    assert!(consume_for_label("main", &state, "after", "vault_reset", "vault").is_ok());
}

#[test]
fn switching_off_enhanced_protection_is_always_confirmed() {
    assert!(requires_confirmation("vault_use_system_protection"));
    assert!(should_show_confirmation(
        "vault_use_system_protection",
        true,
        false
    ));
    let prompt =
        confirmation_prompt("vault_use_system_protection", "vault", "en".into(), true).unwrap();
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
