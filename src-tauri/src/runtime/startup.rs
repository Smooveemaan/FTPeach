//! Runtime initialization after Tauri installs managed state and plugins.
use super::log_emitter::LogEmitter;
use super::{app_log, settings_apply, shutdown, tray, updater, window_bounds};
#[cfg(feature = "smoke-test")]
use crate::commands;
use crate::local_fs::{self, preview::PreviewPaths};
use crate::store::Store;
use crate::transfer::progress::ProgressEmitter;
use tauri::{Emitter, Manager};

#[cfg(windows)]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };
        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
    });
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
        commands::smoke::report_phase("backend-ready");
    }
    let logs_dir = app.state::<Store>().logs_dir();
    // First, so everything after it — the staged-update install included —
    // can leave a record.
    app.handle().plugin(app_log::plugin(logs_dir.clone()))?;
    app_log::record_panics();
    // Ahead of the tray, the window and everything else the user could see:
    // an update downloaded last session installs now, and when its installer
    // starts this process ends here and the new version opens instead.
    updater::install_staged_at_startup(app.handle());
    app.manage(ProgressEmitter::new(app.handle().clone()));
    let preview_paths = app.state::<PreviewPaths>().inner().clone();
    tauri::async_runtime::spawn(async move {
        local_fs::preview::cleanup_stale_sessions(&preview_paths).await;
    });
    let panel = app.handle().clone();
    app.manage(LogEmitter::start(logs_dir, move |batch| {
        let _ = panel.emit("protocol:log", batch);
    }));
    #[cfg(windows)]
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_none()
        && let Some(main_window) = app.get_webview_window("main")
    {
        disable_browser_accelerator_keys(&main_window);
    }
    app.manage(tray::build(app.handle())?);

    let store = app.state::<Store>().inner().clone();
    if let Some(main_window) = app.get_webview_window("main") {
        let persister = window_bounds::BoundsPersister::new(store.clone());
        let window_for_events = main_window.clone();
        main_window.on_window_event(move |event| match event {
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                persister.schedule(window_for_events.clone());
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let app = window_for_events.app_handle().clone();
                let window = window_for_events.clone();
                let store = app.state::<Store>().inner().clone();
                tauri::async_runtime::spawn(shutdown::on_close_requested(app, window, store));
            }
            _ => {}
        });

        let store_for_apply = store.clone();
        tauri::async_runtime::spawn(async move {
            window_bounds::apply_saved_and_show(main_window, store_for_apply).await;
        });
    }

    let log_emitter_for_apply = app.state::<LogEmitter>().inner().clone();
    tauri::async_runtime::spawn(async move {
        settings_apply::apply_at_startup(&store, &log_emitter_for_apply).await;
    });
    updater::check_at_startup(app.handle());

    Ok(())
}
