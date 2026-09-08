//! Presentation of the sensitive-operation confirmation window.
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub(crate) fn show(window: &tauri::WebviewWindow) -> Result<(), &'static str> {
    let parent = window
        .app_handle()
        .get_webview_window("main")
        .ok_or("Parent window unavailable")?;
    center_over_parent(&parent, window);
    window
        .show()
        .map_err(|_| "Confirmation could not be displayed")?;
    window
        .set_focus()
        .map_err(|_| "Confirmation could not be focused")
}

pub(crate) fn center_over_parent(parent: &tauri::WebviewWindow, child: &tauri::WebviewWindow) {
    let (Ok(parent_position), Ok(parent_size), Ok(child_size)) = (
        parent.outer_position(),
        parent.outer_size(),
        child.outer_size(),
    ) else {
        return;
    };
    let x = i64::from(parent_position.x)
        + (i64::from(parent_size.width) - i64::from(child_size.width)) / 2;
    let y = i64::from(parent_position.y)
        + (i64::from(parent_size.height) - i64::from(child_size.height)) / 2;
    let position = tauri::PhysicalPosition::new(
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    );
    let _ = child.set_position(position);
}

#[cfg(windows)]
fn enable_native_rounding(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DWMWA_WINDOW_CORNER_PREFERENCE, DwmSetWindowAttribute},
    };
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };
    let preference: u32 = 2; // DWMWCP_ROUND on Windows 11; ignored by older Windows.
    let hwnd = HWND(handle.hwnd.get() as *mut std::ffi::c_void);
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast(),
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

#[cfg(not(windows))]
fn enable_native_rounding(_: &tauri::WebviewWindow) {}

pub(crate) fn create(
    app: &tauri::AppHandle,
    label: &str,
    request_id: &str,
) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?security-confirmation={request_id}").into()),
    )
    .title("FTPeach")
    .inner_size(460.0, 170.0)
    .min_inner_size(400.0, 160.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .background_color(tauri::utils::config::Color(26, 25, 23, 255))
    .visible(false)
    .build()?;
    enable_native_rounding(&window);
    Ok(window)
}
