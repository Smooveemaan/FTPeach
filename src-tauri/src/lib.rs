mod application;
mod commands;
mod domain;
mod ipc;
mod local_fs;
mod native_drag;
pub mod protocol;
mod runtime;
mod security;
mod session;
pub mod store;
mod transfer;

// Expose the pool only for protocol integration tests.
#[cfg(feature = "test-utils")]
pub use transfer::transfer_pool;

use commands::updater::UpdaterState;
use local_fs::open_with::OpenWithWatchers;
use local_fs::{local_open::ApprovedLocalPaths, preview::PreviewPaths};
use runtime::log_emitter::LogState;
use runtime::{sensitive_plugin, shutdown};
use security::sensitive::AuthorizationState;
use security::{vault, vault_guard};
use session::{ConnectingClients, Sessions};
use store::Store;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("installing the default rustls CryptoProvider should only run once, at startup");

    let smoke_test = std::env::var_os("FTPEACH_SMOKE_TEST").is_some();
    let builder = tauri::Builder::default().on_page_load(|_webview, _payload| {
        #[cfg(feature = "smoke-test")]
        if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
            if let Some((_, result)) = _payload
                .url()
                .query_pairs()
                .find(|(key, _)| key == "ftpeachSmoke")
            {
                commands::smoke::finish(_webview.app_handle(), &result);
            } else if _payload.event() == tauri::webview::PageLoadEvent::Finished
                && let Err(error) = _webview.eval(include_str!("../assets/smoke_test.js"))
            {
                commands::smoke::finish(_webview.app_handle(), &format!("error: {error}"));
            }
        }
    });
    let builder = if smoke_test {
        // Automated instances use an isolated APPDATA and must not be
        // redirected into an already-running interactive FTPeach process.
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };
    let store = Store::new().expect("failed to resolve %APPDATA%\\FTPeach");
    let vault = vault::Vault::new(store.data_dir().to_path_buf());
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(sensitive_plugin::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(store)
        .manage(vault)
        .manage(vault_guard::VaultGuard::default())
        .manage(LogState::default())
        .manage(Sessions::default())
        .manage(ConnectingClients::default())
        .manage(shutdown::ShutdownCoordinator::default())
        .manage(PreviewPaths::default())
        .manage(OpenWithWatchers::default())
        .manage(ApprovedLocalPaths::default())
        .manage(UpdaterState::default())
        .manage(AuthorizationState::default())
        .invoke_handler(tauri::generate_handler![
            commands::fs::fs_list,
            commands::fs::fs_homedir,
            commands::fs::fs_drives,
            commands::fs::fs_mkdir,
            commands::fs::fs_rename,
            commands::fs::fs_copy_file,
            commands::fs::fs_validate_copy,
            commands::fs::fs_create_file,
            commands::fs::fs_is_dir,
            commands::dialog::dialog_select_local_dir,
            commands::dialog::dialog_select_key_file,
            commands::dialog::dialog_select_ca_cert_file,
            commands::dialog::dialog_select_application,
            commands::sites::sites_list,
            commands::sites::sites_has_legacy_secret,
            commands::sites::sites_has_plaintext_secret,
            commands::sites::sites_save,
            commands::sites::sites_delete,
            commands::sites::sites_save_folder,
            commands::sites::sites_delete_folder,
            commands::sites::sites_apply_layout,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::tabs::tabs_get,
            commands::tabs::tabs_set,
            commands::tabs::tabs_clear,
            commands::proxy::proxy_test,
            commands::vault::vault_status,
            commands::vault::vault_setup,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_enable_system_unlock,
            commands::vault::vault_unlock_system,
            commands::vault::vault_disable_system_unlock,
            commands::vault::vault_change_password,
            commands::vault::vault_use_system_protection,
            commands::app::app_version,
            commands::app::app_system_hour_cycle,
            commands::app::app_open_external,
            commands::app::app_set_window_border,
            commands::app::debug_open_devtools,
            commands::app::app_reset_layout,
            commands::log::log_set_enabled,
            commands::log::log_save,
            commands::log::log_export_diagnostics,
            commands::log::log_set_file_logging,
            commands::notifications::notifications_transfers_complete,
            commands::session::connection::session_connect,
            commands::session::connection::session_cancel_connect,
            commands::session::connection::session_disconnect,
            commands::session::browse::session_list,
            commands::session::browse::session_mkdir,
            commands::session::browse::session_create_file,
            commands::session::browse::session_delete,
            commands::session::browse::session_rename,
            commands::session::browse::session_chmod,
            commands::session::connection::session_forget_host_key,
            commands::transfer::transfer_upload,
            commands::transfer::transfer_recursive,
            commands::transfer::transfer_cancel_recursive,
            commands::transfer::transfer_download,
            commands::transfer::transfer_cancel,
            commands::transfer::transfer_remote_copy,
            commands::transfer::transfer_validate_remote_copy,
            commands::transfer::transfer_cancel_remote_copy,
            commands::open_with::open_with_stop,
            commands::drag_out::drag_out_start,
            commands::updater::updater_check,
            commands::updater::updater_download,
            commands::updater::updater_install,
            commands::tray::tray_set_labels,
            #[cfg(feature = "smoke-test")]
            commands::smoke::smoke_backend_checks,
        ])
        .setup(runtime::startup::setup)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
// Application-service unit tests can reach native dialogs. Include Tauri's
// generated manifest so Windows activates Common Controls v6 for this binary.
#[cfg(all(test, windows))]
#[link(name = "resource", kind = "static", modifiers = "-bundle")]
unsafe extern "C" {}
