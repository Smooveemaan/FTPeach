use crate::ipc::{CommandError, CommandResult};
use crate::runtime::shutdown;
use crate::store::{JsonMap, Store};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Whether the spot under a file drag from another app takes the drop, so
/// Windows shows a copy or a "no" cursor there.
#[tauri::command]
pub fn app_set_drop_allowed(allowed: bool) {
    #[cfg(windows)]
    wry::set_drop_allowed(allowed);
    #[cfg(not(windows))]
    let _ = allowed;
}

/// Applies the main window's user zoom; native code owns monitor DPI compensation.
#[tauri::command]
pub async fn app_set_interface_scale(
    window: tauri::WebviewWindow,
    scale: f64,
) -> CommandResult<()> {
    if window.label() != "main" {
        return Err(CommandError::new(
            crate::ipc::ErrorCode::PermissionDenied,
            "Main window only",
        ));
    }
    window
        .state::<crate::runtime::window_scale::InterfaceScale>()
        .set(scale)
        .map_err(|message| CommandError::new(crate::ipc::ErrorCode::InvalidInput, message))?;
    crate::runtime::window_scale::apply(&window)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Acknowledges the backend's bounded save request from the main window only.
#[tauri::command]
pub fn app_state_flushed(
    window: tauri::WebviewWindow,
    state: State<'_, shutdown::ShutdownCoordinator>,
    request_id: String,
    ok: bool,
) -> bool {
    window.label() == "main" && state.state_flushed(&request_id, ok)
}

/// The window settled the transfers. Check for edits once more: an editor
/// may have saved while the window was waiting for transfers to finish.
#[tauri::command]
pub fn app_quit(app: AppHandle, preserve_edits: Option<bool>) {
    let count = app
        .state::<crate::local_fs::open_with::OpenWithWatchers>()
        .unsynced_count();
    if count > 0 && preserve_edits != Some(true) {
        crate::runtime::tray::ask_to_quit(&app, count);
        return;
    }
    shutdown::quit_now(&app);
}

/// The Windows double-click speed in milliseconds, so a row opens on the
/// same two clicks Explorer would take as a double click.
#[tauri::command]
pub fn app_double_click_time() -> Option<u32> {
    #[cfg(windows)]
    {
        let ms = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
        (ms > 0).then_some(ms)
    }

    #[cfg(not(windows))]
    None
}

#[tauri::command]
pub fn app_system_hour_cycle() -> Option<&'static str> {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{GetLocaleInfoEx, LOCALE_STIMEFORMAT};
        use windows::core::PCWSTR;

        let mut buffer = [0u16; 80];
        let length =
            unsafe { GetLocaleInfoEx(PCWSTR::null(), LOCALE_STIMEFORMAT, Some(&mut buffer)) };
        if length <= 1 {
            return None;
        }
        let pattern = String::from_utf16_lossy(&buffer[..length as usize - 1]);
        if pattern.contains('H') {
            Some("h23")
        } else if pattern.contains('h') {
            Some("h12")
        } else {
            None
        }
    }

    #[cfg(not(windows))]
    None
}

/// Recolors the 1px border Windows 11 draws around this window.
///
/// The window is frameless (`decorations: false`), so nothing the webview
/// paints reaches that border -- it belongs to DWM, outside the client area,
/// and no CSS can touch it. `Window::set_theme` does not reach it either: its
/// immersive-dark-mode flag recolors the border that comes with a title bar,
/// and this window has none, so the border stayed at DWMWA_COLOR_DEFAULT --
/// near-black, which reads as a cut-out edge under the light theme.
/// DWMWA_BORDER_COLOR is the one attribute that addresses it, so the frontend
/// hands us the resolved --border of whichever theme it just applied.
#[tauri::command]
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn app_set_window_border(
    app: AppHandle,
    window: tauri::WebviewWindow,
    red: u8,
    green: u8,
    blue: u8,
    appearance: crate::runtime::confirmation_window::Appearance,
) -> CommandResult<()> {
    if window.label() != "main" {
        return Err(CommandError::new(
            crate::ipc::ErrorCode::PermissionDenied,
            "Main window only",
        ));
    }
    let appearance_result =
        crate::runtime::confirmation_window::update_appearance(&app, appearance)
            .map_err(|error| CommandError::from(anyhow::Error::from(error)));
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::{
            Foundation::HWND,
            Graphics::Dwm::{DWMWA_BORDER_COLOR, DwmSetWindowAttribute},
        };

        let Some(window) = app.get_webview_window("main") else {
            return appearance_result;
        };
        let Ok(handle) = window.window_handle() else {
            return appearance_result;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return appearance_result;
        };
        // COLORREF is 0x00BBGGRR, the reverse of the RGB order it arrives in.
        let color = u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16);
        let hwnd = HWND(handle.hwnd.get() as *mut std::ffi::c_void);
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                std::ptr::from_ref(&color).cast(),
                std::mem::size_of_val(&color) as u32,
            );
        }
    }
    appearance_result
}

/// Opens the window's system menu (Restore, Move, Size, ...) at the pointer,
/// as a right click on a native title bar does. The frameless window keeps the
/// menu itself -- Alt+Space reaches it -- but a right click on the webview's
/// title bar is an ordinary page event, so the frontend asks for it here.
#[tauri::command]
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn app_show_system_menu(window: tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        let Ok(handle) = window.window_handle() else {
            return;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return;
        };
        let hwnd = handle.hwnd.get();
        // TrackPopupMenu needs the thread that owns the window.
        if let Err(error) = window.run_on_main_thread(move || show_system_menu(hwnd)) {
            log::warn!("could not show the system menu: {error}");
        }
    }
}

#[cfg(windows)]
fn show_system_menu(hwnd: isize) {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, POINT, WPARAM},
        UI::WindowsAndMessaging::{
            EnableMenuItem, GetCursorPos, GetSystemMenu, IsZoomed, MF_BYCOMMAND, MF_ENABLED,
            MF_GRAYED, PostMessageW, SC_MAXIMIZE, SC_MOVE, SC_RESTORE, SC_SIZE, TPM_RETURNCMD,
            TPM_RIGHTBUTTON, TrackPopupMenu, WM_SYSCOMMAND,
        },
    };

    let hwnd = HWND(hwnd as *mut std::ffi::c_void);
    // SAFETY: hwnd is the live main window and this runs on its thread; the
    // menu belongs to that window and is only read and shown here.
    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if menu.is_invalid() {
            return;
        }
        // Windows refreshes these only for the menus it opens itself.
        let maximized = IsZoomed(hwnd).as_bool();
        let state = |enabled: bool| MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED };
        let _ = EnableMenuItem(menu, SC_RESTORE, state(maximized));
        let _ = EnableMenuItem(menu, SC_MOVE, state(!maximized));
        let _ = EnableMenuItem(menu, SC_SIZE, state(!maximized));
        let _ = EnableMenuItem(menu, SC_MAXIMIZE, state(!maximized));
        let mut point = POINT::default();
        if GetCursorPos(&raw mut point).is_err() {
            return;
        }
        let command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            point.x,
            point.y,
            None,
            hwnd,
            None,
        );
        if command.0 != 0 {
            let _ = PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(command.0 as usize),
                LPARAM(0),
            );
        }
    }
}

#[tauri::command]
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
pub fn debug_open_devtools(app: AppHandle) {
    #[cfg(debug_assertions)]
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

#[tauri::command]
pub fn app_open_external(app: AppHandle, url: String) {
    #[cfg(feature = "smoke-test")]
    if crate::runtime::e2e_browser::hold_back_opening(&url) {
        return;
    }
    if url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<String>);
    }
}

/// The settings a layout reset left behind.
#[derive(Serialize)]
pub struct ResetLayout {
    settings: JsonMap,
}

const DEFAULT_WINDOW_WIDTH: f64 = 1180.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 740.0;

#[tauri::command]
pub async fn app_reset_layout(
    app: AppHandle,
    store: State<'_, Store>,
) -> CommandResult<ResetLayout> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.clear_all_browsing_data();
    }
    match store.reset_layout_settings().await {
        Ok(settings) => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                }
                let _ = window.set_size(tauri::LogicalSize::new(
                    DEFAULT_WINDOW_WIDTH,
                    DEFAULT_WINDOW_HEIGHT,
                ));
                let _ = window.center();
            }
            Ok(ResetLayout { settings })
        }
        Err(e) => Err(CommandError::from_anyhow(&anyhow::anyhow!(e.to_string()))),
    }
}

#[path = "app_settings_transfer.rs"]
pub(crate) mod settings_transfer;
