use crate::ipc::{CommandError, CommandResult};
use crate::store::{JsonMap, Store};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
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
pub fn app_set_window_border(app: AppHandle, red: u8, green: u8, blue: u8) {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::{
            Foundation::HWND,
            Graphics::Dwm::{DWMWA_BORDER_COLOR, DwmSetWindowAttribute},
        };

        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(handle) = window.window_handle() else {
            return;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return;
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
    if url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<String>);
    }
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum ResetLayoutResult {
    Ok { ok: bool, settings: JsonMap },
    Err { ok: bool, error: CommandError },
}

const DEFAULT_WINDOW_WIDTH: f64 = 1180.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 740.0;

#[tauri::command]
pub async fn app_reset_layout(
    app: AppHandle,
    store: State<'_, Store>,
) -> CommandResult<ResetLayoutResult> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.clear_all_browsing_data();
    }
    let result = match store.reset_layout_settings().await {
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
            ResetLayoutResult::Ok { ok: true, settings }
        }
        Err(e) => ResetLayoutResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&anyhow::anyhow!(e.to_string())),
        },
    };
    Ok(result)
}

#[path = "app_settings_transfer.rs"]
pub(crate) mod settings_transfer;
