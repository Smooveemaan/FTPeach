mod menu;
pub(crate) mod model;

use menu::{LiveMenu, MenuCommand};
use model::{TrayAction, TrayModel};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow,
    menu::MenuEvent,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "main";
const ACTION_EVENT: &str = "tray:action";

/// The tray icon only exists while the main window is hidden to the tray, so
/// it is created and removed at runtime; this keeps what it needs in between.
pub struct TrayState {
    inner: Mutex<TrayInner>,
}

struct TrayInner {
    /// What the renderer last asked the icon to show; `None` until it has.
    model: Option<TrayModel>,
    /// The live icon's menu, `None` while there is no icon.
    live: Option<LiveMenu>,
    /// Whether the window is hidden to the tray. The icon is removed on a
    /// later turn of the event loop, and a hide landing in between keeps it.
    hidden: bool,
}

impl TrayInner {
    fn model(&self) -> TrayModel {
        self.model.clone().unwrap_or_default()
    }
}

impl TrayState {
    fn lock(&self) -> MutexGuard<'_, TrayInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Stores the renderer's model for an icon created later and applies it to
/// the current one.
pub fn set_model(app: &AppHandle, model: TrayModel) {
    let has_icon = {
        let state = app.state::<TrayState>();
        let mut inner = state.lock();
        inner.model = Some(model);
        inner.live.is_some()
    };
    if !has_icon {
        return;
    }
    // On the main thread, like every other change to the icon: the item
    // setters wait for it, and it may be holding this lock right now.
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let state = handle.state::<TrayState>();
        let mut inner = state.lock();
        let model = inner.model();
        let (Some(live), Some(tray)) = (inner.live.as_mut(), handle.tray_by_id(TRAY_ID)) else {
            return;
        };
        if let Err(error) = live.apply(&handle, &tray, &model) {
            log::warn!("could not update the tray menu: {error}");
        }
    });
    if let Err(error) = result {
        log::warn!("could not update the tray menu: {error}");
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
            model: None,
            live: None,
            hidden: false,
        }),
    });
    // Once, here: a menu handler given to the tray builder is added to a
    // global list on every build, so each re-created icon would stack another.
    app.on_menu_event(move |app, event: MenuEvent| {
        let id = event.id().as_ref();
        if !id.starts_with("tray-") {
            return;
        }
        // The command is read from the model the menu was drawn from, not
        // from the item's text.
        let command = menu::command_for(&app.state::<TrayState>().lock().model(), id);
        match command {
            Some(MenuCommand::Show) => restore(app),
            Some(MenuCommand::Quit) => quit(app),
            Some(MenuCommand::Action(action)) => send_action(app, &action),
            None => {}
        }
    });
}

fn send_action(app: &AppHandle, action: &TrayAction) {
    if let Err(error) = app.emit_to("main", ACTION_EVENT, action) {
        log::warn!("could not send a tray action to the window: {error}");
    }
}

/// Puts the icon in the tray, then hides the window. Runs on the main thread,
/// which owns the icon's hidden window.
pub fn hide_to_tray(window: WebviewWindow) {
    let app = window.app_handle().clone();
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let state = handle.state::<TrayState>();
        let mut inner = state.lock();
        if inner.live.is_none() {
            match create(&handle, &inner.model()) {
                Ok(live) => inner.live = Some(live),
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
            if !inner.hidden && inner.live.take().is_some() {
                drop(handle.remove_tray_by_id(TRAY_ID));
            }
        });
        if let Err(error) = result {
            log::warn!("could not remove the tray icon: {error}");
        }
    });
}

fn create(app: &AppHandle, model: &TrayModel) -> tauri::Result<LiveMenu> {
    let live = LiveMenu::build(app, model)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(live.menu())
        .tooltip(live.tooltip())
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
    Ok(live)
}
