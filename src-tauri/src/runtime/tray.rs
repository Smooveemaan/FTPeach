use crate::runtime::shutdown::{self, ShutdownCoordinator};
use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub struct TrayState {
    pub show_item: MenuItem<tauri::Wry>,
    pub quit_item: MenuItem<tauri::Wry>,
}

fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<TrayState> {
    let show_item = MenuItem::with_id(app, "tray-show", "Show FTPeach", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("FTPeach")
        // Left click toggles show/hide (below); the menu still opens on
        // right click, same as Windows' own tray convention.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_and_focus(app),
            "tray-quit" => match app.get_webview_window("main") {
                Some(window) => {
                    if app.state::<ShutdownCoordinator>().begin() {
                        tauri::async_runtime::spawn(shutdown::run(app.clone(), window));
                    }
                }
                _ => {
                    app.exit(0);
                }
            },
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let shown = app.get_webview_window("main").is_some_and(|w| {
                    w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
                });
                if shown {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                } else {
                    show_and_focus(app);
                }
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    Ok(TrayState {
        show_item,
        quit_item,
    })
}
