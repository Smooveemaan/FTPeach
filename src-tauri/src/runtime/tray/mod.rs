mod menu;
pub(crate) mod model;

use menu::{LiveMenu, MenuCommand};
use model::{TrayAction, TrayModel};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow,
    image::Image,
    include_image,
    menu::MenuEvent,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "main";
const ACTION_EVENT: &str = "tray:action";
const MENU_CALLBACK_SETTLE: Duration = Duration::from_millis(100);

/// The tray icon only exists while the main window is hidden to the tray, so
/// it is created and removed at runtime; this keeps what it needs in between.
pub struct TrayState {
    inner: Mutex<TrayInner>,
}

struct TrayInner {
    /// What the renderer last asked the icon to show; `None` until it has.
    model: Option<TrayModel>,
    /// Counts the models received, so a caller can tell whether the
    /// renderer has said anything since a given moment.
    generation: u64,
    /// The live icon's menu, `None` while there is no icon.
    live: Option<LiveMenu>,
    /// Whether the window is hidden to the tray. The icon is removed on a
    /// later turn of the event loop, and a hide landing in between keeps it.
    hidden: bool,
    last_menu_event: Option<Instant>,
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
    let (has_icon, defer) = {
        let state = app.state::<TrayState>();
        let mut inner = state.lock();
        inner.model = Some(model);
        inner.generation += 1;
        (
            inner.live.is_some(),
            inner
                .last_menu_event
                .is_some_and(|at| at.elapsed() < MENU_CALLBACK_SETTLE),
        )
    };
    if !has_icon {
        return;
    }
    let app = app.clone();
    let update = move || {
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
    };
    if defer {
        // Replacing the menu inside its native invocation can leave it open.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(MENU_CALLBACK_SETTLE).await;
            update();
        });
    } else {
        update();
    }
}

/// How many transfers the renderer last reported as running. None before it
/// has reported anything, so a renderer that never started cannot hold up
/// quitting.
pub fn active_transfers(app: &AppHandle) -> u32 {
    let state = app.state::<TrayState>();
    let inner = state.lock();
    inner
        .model
        .as_ref()
        .map_or(0, |model| model.transfers.active)
}

/// Changes whenever the renderer sends a model.
pub fn model_generation(app: &AppHandle) -> u64 {
    app.state::<TrayState>().lock().generation
}

/// Whether the window is already asking whether to quit.
pub fn quit_prompt_open(app: &AppHandle) -> bool {
    let state = app.state::<TrayState>();
    let inner = state.lock();
    inner
        .model
        .as_ref()
        .is_some_and(|model| model.quit_prompt_open)
}

/// Asks the window what to do about quitting while transfers run.
pub fn ask_to_quit(app: &AppHandle, unsynced_edits: usize) {
    send_action(app, &TrayAction::QuitRequested { unsynced_edits });
}

fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        #[cfg(feature = "smoke-test")]
        if crate::runtime::e2e_browser::active() {
            return crate::runtime::e2e_browser::show_without_focus(&window);
        }
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
            generation: 0,
            live: None,
            hidden: false,
            last_menu_event: None,
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
        let command = {
            let state = app.state::<TrayState>();
            let mut inner = state.lock();
            inner.last_menu_event = Some(Instant::now());
            // Menu events arrive on the main thread, where the setters this
            // calls take effect at once.
            if let Some(live) = &inner.live
                && let Err(error) = live.resync_checks()
            {
                log::warn!("could not reset the tray menu's check marks: {error}");
            }
            menu::command_for(&inner.model(), id)
        };
        match command {
            Some(MenuCommand::Show) => restore(app),
            Some(MenuCommand::Quit) => quit(app),
            Some(MenuCommand::Action(action)) => {
                // Connecting needs the window: it may ask before replacing a
                // connection, and it is where the result shows.
                if matches!(action, TrayAction::Connect { .. }) {
                    restore(app);
                }
                send_action(app, &action);
            }
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
        crate::runtime::confirmation_window::close_all(&handle);
        crate::runtime::vault_auto_lock::enforce_now(&handle);
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
    // Removing the icon from inside its native menu callback can strand that
    // menu on screen; let Windows finish the invocation first.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MENU_CALLBACK_SETTLE).await;
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

/// Configuration for the tray/menu-bar icon behavior per platform.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct TrayIconConfig {
    /// On macOS, status bar extra icons must be configured as template images
    /// so the system automatically adjusts contrast for light/dark menu bar modes.
    pub is_template: bool,
    /// On macOS, clicking the menu bar icon always displays its menu.
    /// On Windows, right-click displays the menu while left-click restores the window.
    pub show_menu_on_left_click: bool,
    /// Whether left-click on the tray icon restores the window.
    pub restore_on_left_click: bool,
}

pub fn tray_icon_config(is_macos: bool) -> TrayIconConfig {
    TrayIconConfig {
        is_template: is_macos,
        show_menu_on_left_click: is_macos,
        restore_on_left_click: !is_macos,
    }
}

fn create(app: &AppHandle, model: &TrayModel) -> tauri::Result<LiveMenu> {
    let live = LiveMenu::build(app, model)?;
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor());
    let config = tray_icon_config(cfg!(target_os = "macos"));
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_for_scale(scale))
        .menu(live.menu())
        .tooltip(live.tooltip())
        .icon_as_template(config.is_template)
        .show_menu_on_left_click(config.show_menu_on_left_click);

    if config.restore_on_left_click {
        // Left click brings the window back; the menu opens on right click,
        // same as Windows' own tray convention. On macOS, left click opens the
        // menu bar extra directly.
        builder = builder.on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore(tray.app_handle());
            }
        });
    }

    builder.build(app)?;
    Ok(live)
}

/// The peach on its own; the app icon's square plate stays out of the tray.
/// A tray icon is 16 px at 100% display scale, and each file is the vector
/// logo drawn at exactly the size its scale asks for, because an icon of
/// another size is resized by Windows into a blur. The notification area sits
/// on the primary monitor, so that monitor's scale decides.
fn icon_for_scale(scale: f64) -> Image<'static> {
    if scale <= 1.0 {
        include_image!("./icons/tray/16.png")
    } else if scale <= 1.25 {
        include_image!("./icons/tray/20.png")
    } else if scale <= 1.5 {
        include_image!("./icons/tray/24.png")
    } else if scale <= 1.75 {
        include_image!("./icons/tray/28.png")
    } else if scale <= 2.0 {
        include_image!("./icons/tray/32.png")
    } else if scale <= 2.5 {
        include_image!("./icons/tray/40.png")
    } else {
        include_image!("./icons/tray/48.png")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_icon_matches_the_display_scale() {
        for (scale, size) in [
            (1.0, 16),
            (1.25, 20),
            (1.5, 24),
            (1.75, 28),
            (2.0, 32),
            (2.5, 40),
            (3.0, 48),
            (4.0, 48),
        ] {
            let icon = icon_for_scale(scale);
            assert_eq!(
                (icon.width(), icon.height()),
                (size, size),
                "at scale {scale}"
            );
        }
    }

    #[test]
    fn tray_icon_configuration_matches_platform_conventions() {
        let macos = tray_icon_config(true);
        assert!(
            macos.is_template,
            "macOS menu bar extra must be a template icon"
        );
        assert!(
            macos.show_menu_on_left_click,
            "macOS left click must open menu"
        );
        assert!(
            !macos.restore_on_left_click,
            "macOS left click should not restore window directly"
        );

        let windows = tray_icon_config(false);
        assert!(!windows.is_template, "Windows tray icon is not a template");
        assert!(
            !windows.show_menu_on_left_click,
            "Windows left click does not show menu (right click does)"
        );
        assert!(
            windows.restore_on_left_click,
            "Windows left click restores window"
        );
    }
}
