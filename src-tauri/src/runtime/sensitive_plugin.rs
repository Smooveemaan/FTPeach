//! Registration for the `sensitive` Tauri plugin.
//!
//! The authorization rules themselves live in `security::sensitive`; what
//! lives here is the *list* of commands placed behind them. That list names
//! `crate::commands::…` entries, which a domain zone is not allowed to do —
//! deciding which command is gated is process wiring, the same kind of
//! decision as `lib.rs`'s `generate_handler!`, so it belongs to `runtime`.

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("sensitive")
        .invoke_handler(tauri::generate_handler![
            crate::security::sensitive::authorize_sensitive,
            crate::security::sensitive::sensitive_confirmation_prompt,
            crate::security::sensitive::sensitive_confirmation_ready,
            crate::security::sensitive::respond_sensitive_confirmation,
            crate::commands::sites::sites_reveal_secret,
            crate::commands::settings::settings_reveal_proxy_password,
            crate::commands::vault::vault_reset,
            crate::commands::fs::fs_delete,
            crate::commands::fs::fs_reveal_path,
            crate::commands::fs::fs_open_document,
            crate::commands::fs::fs_execute_path,
            crate::commands::open_with::open_with_start,
            crate::commands::app::settings_transfer::app_export_settings,
            crate::commands::app::settings_transfer::app_import_settings,
        ])
        .build()
}
