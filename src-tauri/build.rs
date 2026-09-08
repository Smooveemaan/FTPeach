fn main() {
    const COMMANDS: &[&str] = &[
        "authorize_sensitive",
        "sensitive_confirmation_prompt",
        "sensitive_confirmation_ready",
        "respond_sensitive_confirmation",
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
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "sensitive",
        tauri_build::InlinedPlugin::new().commands(COMMANDS),
    ))
    .expect("failed to build Tauri application");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(
            "cargo:rustc-link-search=native={}",
            std::env::var("OUT_DIR").unwrap()
        );
    }
}
