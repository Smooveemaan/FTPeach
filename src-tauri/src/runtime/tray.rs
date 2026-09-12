use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{
    AppHandle, Manager, WebviewWindow,
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "main";

/// The tray icon only exists while the main window is hidden to the tray, so
/// it is created and removed at runtime; this keeps what it needs in between.
pub struct TrayState {
    inner: Mutex<TrayInner>,
}

struct TrayInner {
    show_label: String,
    quit_label: String,
    /// The live icon's show and quit items, `None` while there is no icon.
    items: Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>,
    /// Whether the window is hidden to the tray. The icon is removed on a
    /// later turn of the event loop, and a hide landing in between keeps it.
    hidden: bool,
}

impl TrayState {
    fn lock(&self) -> MutexGuard<'_, TrayInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Remembers the localized labels for an icon created later and applies
    /// them to the current one.
    pub fn set_labels(&self, show: String, quit: String) {
        let items = {
            let mut inner = self.lock();
            inner.show_label = show.clone();
            inner.quit_label = quit.clone();
            inner.items.clone()
        };
        // Outside the lock: `set_text` waits for the main thread, which may
        // be holding this same lock.
        if let Some((show_item, quit_item)) = items {
            let _ = show_item.set_text(show);
            let _ = quit_item.set_text(quit);
        }
    }
}

fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Registers what the tray needs for the life of the app; `quit` runs from
/// the icon's menu. The icon itself comes and goes with [`hide_to_tray`] and
/// [`restore`].
pub fn install(app: &AppHandle, quit: fn(&AppHandle)) {
    app.manage(TrayState {
        inner: Mutex::new(TrayInner {
            show_label: "Show FTPeach".into(),
            quit_label: "Quit".into(),
            items: None,
            hidden: false,
        }),
    });
    // Once, here: a menu handler given to the tray builder is added to a
    // global list on every build, so each re-created icon would stack another.
    app.on_menu_event(move |app, event: MenuEvent| match event.id().as_ref() {
        "tray-show" => restore(app),
        "tray-quit" => quit(app),
        _ => {}
    });
}

/// Puts the icon in the tray, then hides the window. Runs on the main thread,
/// which owns the icon's hidden window.
pub fn hide_to_tray(window: WebviewWindow) {
    let app = window.app_handle().clone();
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let state = handle.state::<TrayState>();
        let mut inner = state.lock();
        if inner.items.is_none() {
            match create(&handle, &inner.show_label, &inner.quit_label) {
                Ok(items) => inner.items = Some(items),
                Err(error) => {
                    log::warn!("could not create the tray icon: {error}");
                    // Hidden with no icon, the window would have no way back.
                    let _ = window.minimize();
                    return;
                }
            }
        }
        inner.hidden = true;
        let _ = window.hide();
    });
    if let Err(error) = result {
        log::warn!("could not hide the window to the tray: {error}");
    }
}

/// Brings the window back and takes the icon out of the tray. Anything that
/// reopens the window, such as a second launch, goes through here.
pub fn restore(app: &AppHandle) {
    app.state::<TrayState>().lock().hidden = false;
    show_and_focus(app);
    // Removed on a later turn of the event loop: this usually runs inside the
    // icon's own click or menu handler.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = handle.clone();
        let result = app.run_on_main_thread(move || {
            let state = handle.state::<TrayState>();
            let mut inner = state.lock();
            if !inner.hidden && inner.items.take().is_some() {
                drop(handle.remove_tray_by_id(TRAY_ID));
            }
        });
        if let Err(error) = result {
            log::warn!("could not remove the tray icon: {error}");
        }
    });
}

fn create(
    app: &AppHandle,
    show_label: &str,
    quit_label: &str,
) -> tauri::Result<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)> {
    let show_item = MenuItem::with_id(app, "tray-show", show_label, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("FTPeach")
        // Left click brings the window back; the menu opens on right click,
        // same as Windows' own tray convention.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    Ok((show_item, quit_item))
}
