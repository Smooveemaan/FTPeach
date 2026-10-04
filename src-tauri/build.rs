fn main() {
    // Commands the sensitive plugin registers. They are permissioned per
    // window through the `sensitive:` prefix.
    const SENSITIVE_COMMANDS: &[&str] = &[
        "authorize_sensitive",
        "sensitive_confirmation_prompt",
        "sensitive_confirmation_ready",
        "respond_sensitive_confirmation",
        "sites_reveal_secret",
        "sites_save",
        "settings_reveal_proxy_password",
        "vault_reset",
        "fs_delete",
        "fs_reveal_path",
        "fs_open_document",
        "fs_execute_path",
        "open_with_start",
        "session_trust_host_key",
        "app_export_settings",
        "app_import_settings",
        "settings_set_security",
        "vault_use_system_protection",
    ];
    // Every command registered by `invoke_handler` in `lib.rs`. Without this
    // manifest Tauri leaves app commands unpermissioned, which makes them
    // callable from any window of the application, including the isolated
    // confirmation window. Declaring them turns on the ACL check for all of
    // them, so each window only reaches what its capability file grants.
    // `scripts/checks/check-command-acl.ts` fails the build when this list,
    // the registered commands and the capability files drift apart.
    //
    // The three `smoke_*` entries are only registered under the `smoke-test`
    // feature. Their permissions are always defined so that one capability
    // file stays valid for both builds; a production binary simply has no
    // such command to reach.
    const APP_COMMANDS: &[&str] = &[
        "fs_list",
        "fs_cancel_list",
        "fs_homedir",
        "fs_drives",
        "fs_mkdir",
        "fs_rename",
        "fs_copy_file",
        "fs_validate_copy",
        "fs_create_file",
        "fs_is_dir",
        "dialog_select_local_dir",
        "dialog_select_key_file",
        "dialog_select_ca_cert_file",
        "dialog_select_application",
        "sites_list",
        "sites_has_legacy_secret",
        "sites_has_plaintext_secret",
        "sites_delete",
        "sites_save_folder",
        "sites_delete_folder",
        "sites_apply_layout",
        "settings_get",
        "settings_set",
        "tabs_get",
        "tabs_set",
        "tabs_clear",
        "proxy_test",
        "vault_status",
        "vault_setup",
        "vault_unlock",
        "vault_lock",
        "vault_enable_system_unlock",
        "vault_unlock_system",
        "vault_disable_system_unlock",
        "vault_change_password",
        "vault_note_activity",
        "app_version",
        "app_quit",
        "app_state_flushed",
        "app_system_hour_cycle",
        "app_open_external",
        "app_set_window_border",
        "app_set_interface_scale",
        "debug_open_devtools",
        "app_reset_layout",
        "log_recent",
        "log_save",
        "log_export_diagnostics",
        "log_set_file_logging",
        "log_open_folder",
        "notifications_transfers_complete",
        "session_connect",
        "session_cancel_connect",
        "session_disconnect",
        "session_list",
        "session_mkdir",
        "session_create_file",
        "session_delete",
        "session_rename",
        "session_chmod",
        "transfer_upload",
        "transfer_recursive",
        "transfer_cancel_recursive",
        "transfer_discard_recursive",
        "transfer_download",
        "transfer_cancel",
        "transfer_remote_copy",
        "transfer_validate_remote_copy",
        "transfer_cancel_remote_copy",
        "open_with_stop",
        "open_with_mark_synced",
        "open_with_recovered_edits",
        "open_with_reveal_recovered_edits",
        "open_with_discard_recovered_edits",
        "drag_out_start",
        "drag_out_start_local",
        "updater_status",
        "updater_check",
        "updater_download",
        "updater_install",
        "tray_set_model",
        "tray_hide_window",
        "smoke_backend_checks",
        "smoke_finish",
        "smoke_probe_confirmation_acl",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS))
            .plugin(
                "sensitive",
                tauri_build::InlinedPlugin::new().commands(SENSITIVE_COMMANDS),
            ),
    )
    .expect("failed to build Tauri application");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(
            "cargo:rustc-link-search=native={}",
            std::env::var("OUT_DIR").unwrap()
        );
    }
}
