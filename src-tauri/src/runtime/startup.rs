//! Runtime initialization after Tauri installs managed state and plugins.
#[cfg(target_os = "macos")]
use super::app_menu;
use super::log_emitter::LogEmitter;
use super::{
    app_log, notification, settings_apply, shutdown, tray, updater, vault_auto_lock, window_bounds,
};
#[cfg(feature = "smoke-test")]
use crate::commands;
use crate::local_fs::{self, open_with::OpenWithSession};
use crate::security::auto_lock::AutoLock;
use crate::store::Store;
use crate::transfer::progress::ProgressEmitter;
use tauri::{Emitter, Manager};

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
        commands::smoke::report_phase("setup-started");
    }
    let logs_dir = app.state::<Store>().logs_dir();
    // First, so everything after it — window creation and the staged-update
    // install included — can leave a record in ftpeach-app.log.
    app.handle().plugin(app_log::plugin(logs_dir.clone()))?;
    app_log::record_panics();
    app_log::start(app.handle());
    // Declared in tauri.conf.json with `create: false` and built here, so a
    // portable copy can keep the WebView2 profile beside the program. Left to
    // Tauri, the profile and its folder go under %LOCALAPPDATA%.
    build_main_window(app)?;
    #[cfg(feature = "smoke-test")]
    super::e2e_control::start(app.handle())?;
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
        commands::smoke::report_phase("window-built");
    }
    let data_dir = local_fs::edit_recovery::data_dir(app.handle())
        .ok_or_else(|| std::io::Error::other("No local application data directory"))?;
    let open_with_session = OpenWithSession::under(&data_dir);
    app.manage(local_fs::open_with::OpenWithWatchers::new(
        open_with_session.dir.clone(),
    ));
    app.manage(open_with_session);
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
        commands::smoke::report_phase("backend-ready");
    }
    #[cfg(target_os = "linux")]
    super::system_theme::start(app.handle().clone());
    // Windows installs ahead of the tray and visible window. Unix checks the
    // saved update asynchronously so an unavailable server cannot block startup.
    #[cfg(windows)]
    log::debug!("startup: checking staged update");
    #[cfg(windows)]
    updater::install_staged_at_startup(app.handle());
    // Before anything can finish and ask for a toast. Re-registered every
    // launch so a moved or reinstalled FTPeach still points Windows at an
    // icon that exists.
    notification::register_identity(app.handle());
    #[cfg(target_os = "macos")]
    local_fs::recycle_bin::ask_for_finder_access();
    #[cfg(target_os = "macos")]
    super::dock::set_dock_title("FTPeach");
    #[cfg(target_os = "macos")]
    app_menu::install(app.handle())?;
    app.manage(ProgressEmitter::new(app.handle().clone()));
    let panel = app.handle().clone();
    app.manage(LogEmitter::start(logs_dir, move |batch| {
        let _ = panel.emit("protocol:log", batch);
    }));
    #[cfg(windows)]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_none()
        && let Some(main_window) = app.get_webview_window("main")
    {
        super::browser_keys::disable(&main_window);
    }
    // The icon itself only appears while the window is hidden to the tray.
    tray::install(app.handle(), shutdown::quit);

    let store = app.state::<Store>().inner().clone();
    if let Some(main_window) = app.get_webview_window("main") {
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::ApplicationWindowExt;
            // GTK can paint an empty native menubar above our web-based menu.
            main_window.gtk_window()?.set_show_menubar(false);
            super::linux_window_frame::install(&main_window)?;
        }
        #[cfg(windows)]
        super::window_resize::install(&main_window);
        #[cfg(target_os = "macos")]
        super::window_zoom::install(&main_window);
        super::window_scale::refresh(&main_window);
        let persister = window_bounds::BoundsPersister::new(store.clone());
        let window_for_events = main_window.clone();
        main_window.on_window_event(move |event| match event {
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                super::window_scale::refresh(&window_for_events);
            }
            tauri::WindowEvent::Resized(size) => {
                log::debug!(
                    "window: resized to {}x{} physical pixels",
                    size.width,
                    size.height
                );
                super::window_scale::sync_min_size_if_pending(&window_for_events);
                persister.schedule(window_for_events.clone());
                if window_for_events.is_minimized().unwrap_or(false) {
                    log::debug!("window: minimized");
                    super::vault_auto_lock::enforce_now(window_for_events.app_handle());
                    #[cfg(not(target_os = "macos"))]
                    {
                        // The title bar button asks for the tray itself; this
                        // covers minimizing from outside the page: the window
                        // menu, Win+Down, the taskbar button.
                        let window = window_for_events.clone();
                        let store = window.state::<Store>().inner().clone();
                        tauri::async_runtime::spawn(async move {
                            let to_tray = store
                                .get_settings()
                                .await
                                .get("minimizeToTray")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false);
                            if to_tray {
                                tray::hide_to_tray(window);
                            }
                        });
                    }
                }
            }
            tauri::WindowEvent::Moved(position) => {
                log::debug!(
                    "window: moved to {},{} physical pixels",
                    position.x,
                    position.y
                );
                persister.schedule(window_for_events.clone());
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                log::debug!("window: close requested");
                api.prevent_close();
                let app = window_for_events.app_handle().clone();
                let window = window_for_events.clone();
                let store = app.state::<Store>().inner().clone();
                tauri::async_runtime::spawn(shutdown::on_close_requested(app, window, store));
            }
            tauri::WindowEvent::Focused(focused) => {
                log::debug!("window: focused={focused}");
                #[cfg(target_os = "linux")]
                if *focused {
                    notification::clear_delivered(window_for_events.app_handle());
                }
            }
            tauri::WindowEvent::Destroyed => {
                log::debug!("window: destroyed");
            }
            _ => {}
        });

        let store_for_apply = store.clone();
        tauri::async_runtime::spawn(async move {
            window_bounds::apply_saved_and_show(main_window, store_for_apply).await;
        });
    }

    let log_emitter_for_apply = app.state::<LogEmitter>().inner().clone();
    let app_for_apply = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let loaded_settings = store.get_settings().await;
        settings_apply::apply(&loaded_settings, &store, &log_emitter_for_apply);
        tray::apply_menu_bar_setting(&app_for_apply, &loaded_settings);
        vault_auto_lock::apply_at_startup(&store, app_for_apply.state::<AutoLock>().inner()).await;
        store.scrub_secret_backups().await;
    });
    // The vault's own protection, so it survives a renderer that stops
    // running its timers or never finishes loading.
    vault_auto_lock::start(app.handle());
    updater::check_at_startup(app.handle());

    log::debug!("startup: setup complete");

    Ok(())
}

fn build_main_window_once(app: &tauri::App) -> Result<(), tauri::Error> {
    let mut main_window =
        tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
            .accept_first_mouse(true);
    #[cfg(target_os = "linux")]
    {
        main_window = main_window
            .transparent(true)
            .background_color(tauri::utils::config::Color(0, 0, 0, 0));
    }
    if let Some(root) = local_fs::portable::root() {
        main_window = main_window.data_directory(local_fs::portable::webview_dir(root));
    }
    #[cfg(feature = "smoke-test")]
    if let Some(args) = super::e2e_browser::args() {
        main_window = main_window.additional_browser_args(&args);
    }
    main_window.build().map(drop)
}

#[cfg(any(windows, test))]
fn is_webview_profile_busy_message(message: &str) -> bool {
    // WebView2 returns ERROR_BUSY (0x800700AA) when a just-exited instance's
    // msedgewebview2.exe helpers are still releasing EBWebView on restart.
    message.contains("0x800700AA")
}

#[cfg(windows)]
fn build_main_window(app: &tauri::App) -> Result<(), tauri::Error> {
    const MAX_ATTEMPTS: usize = 25;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(200);
    for attempt in 1..=MAX_ATTEMPTS {
        match build_main_window_once(app) {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt < MAX_ATTEMPTS
                    && is_webview_profile_busy_message(&error.to_string()) =>
            {
                log::warn!(
                    "startup: WebView2 profile busy on attempt {attempt}/{MAX_ATTEMPTS}, retrying: {error}"
                );
                std::thread::sleep(RETRY_DELAY);
            }
            Err(error) => {
                log::error!("startup: failed to build main window: {error}");
                return Err(error);
            }
        }
    }
    unreachable!()
}

#[cfg(not(windows))]
fn build_main_window(app: &tauri::App) -> Result<(), tauri::Error> {
    if let Err(error) = build_main_window_once(app) {
        log::error!("startup: failed to build main window: {error}");
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_webview_profile_busy_message;

    #[test]
    fn recognizes_windows_webview2_busy_error() {
        let busy = r#"runtime error: failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA), message: "The requested resource is in use." })"#;
        assert!(is_webview_profile_busy_message(busy));
        assert!(!is_webview_profile_busy_message(
            r#"runtime error: failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x80070005), message: "Access is denied." })"#
        ));
    }
}
