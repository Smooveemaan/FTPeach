use super::*;

fn grant(state: &AuthorizationState, token: &str, operation: &str, target: &str, expires: Instant) {
    state.grants.lock().unwrap().insert(
        token.into(),
        Grant {
            window: "main".into(),
            operation: operation.into(),
            target: target.into(),
            expires,
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
    for (operation, target) in [
        ("sites_reveal_secret", "site:password"),
        ("settings_reveal_proxy_password", "proxy"),
        ("vault_reset", "vault"),
        ("fs_execute_path", "tool.exe"),
        ("open_with_start", "/remote/tool.ps1"),
    ] {
        assert!(requires_confirmation(operation, target));
    }

    for (operation, target) in [
        ("fs_delete", "document.txt"),
        ("fs_reveal_path", "document.txt"),
        ("fs_open_document", "document.txt"),
        ("open_with_start", "/remote/document.pdf"),
        ("app_export_settings", "native-dialog"),
        ("app_import_settings", "native-dialog"),
    ] {
        assert!(!requires_confirmation(operation, target));
    }
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
    assert!(should_show_confirmation("vault_reset", "vault", false));
    assert!(!should_show_confirmation(
        "sites_reveal_secret",
        "site:password",
        false
    ));
    assert!(!should_show_confirmation(
        "fs_execute_path",
        "tool.exe",
        false
    ));
    assert!(should_show_confirmation(
        "fs_execute_path",
        "tool.exe",
        true
    ));
}

#[test]
fn enhanced_secret_reveal_always_prompts_for_reauthentication() {
    for operation in ["sites_reveal_secret", "settings_reveal_proxy_password"] {
        assert!(should_prompt(operation, "secret", false, true));
        assert!(should_prompt(operation, "secret", true, true));
    }
    assert!(!should_prompt(
        "sites_reveal_secret",
        "secret",
        false,
        false
    ));
}
