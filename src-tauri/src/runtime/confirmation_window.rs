//! Presentation of the sensitive-operation confirmation window.
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// The native handle a Windows Hello prompt is shown over.
#[cfg(windows)]
pub(crate) fn window_handle(window: &tauri::WebviewWindow) -> anyhow::Result<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle()?.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get()),
        _ => anyhow::bail!("system unlock requires a Windows application window"),
    }
}

#[cfg(not(windows))]
pub(crate) fn window_handle(_: &tauri::WebviewWindow) -> anyhow::Result<isize> {
    Ok(0)
}

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

/// The child is sized in logical pixels. Its physical size is taken from that
/// at the parent's scale: when it has just crossed to the parent's monitor,
/// Windows may not have resized it for that monitor's scale yet.
pub(crate) fn center_over_parent(parent: &tauri::WebviewWindow, child: &tauri::WebviewWindow) {
    let (Ok(parent_position), Ok(parent_size), Ok(parent_scale), Ok(child_size), Ok(child_scale)) = (
        parent.outer_position(),
        parent.outer_size(),
        parent.scale_factor(),
        child.outer_size(),
        child.scale_factor(),
    ) else {
        return;
    };
    let child_size = child_size
        .to_logical::<f64>(child_scale)
        .to_physical::<u32>(parent_scale);
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

const WIDTH: f64 = 460.0;
const HEIGHT: f64 = 170.0;

/// The theme the main window shows: the saved choice, or Windows' own for
/// "system", read from the main window.
fn light_theme(app: &tauri::AppHandle, preference: Option<&str>) -> bool {
    match preference {
        Some("light") => true,
        Some("dark") => false,
        _ => app
            .get_webview_window("main")
            .and_then(|main| main.theme().ok())
            .is_some_and(|theme| theme == tauri::Theme::Light),
    }
}

pub(crate) fn create(
    app: &tauri::AppHandle,
    label: &str,
    request_id: &str,
    theme: Option<&str>,
) -> tauri::Result<tauri::WebviewWindow> {
    let light = light_theme(app, theme);
    let theme = if light { "light" } else { "dark" };
    // Matches --bg-panel, so the window shows no other color before it paints.
    let background = if light {
        tauri::utils::config::Color(250, 249, 247, 255)
    } else {
        tauri::utils::config::Color(26, 25, 23, 255)
    };
    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(
            format!("index.html?security-confirmation={request_id}&theme={theme}").into(),
        ),
    )
    .title("FTPeach")
    .inner_size(WIDTH, HEIGHT)
    .min_inner_size(400.0, 160.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .background_color(background)
    .visible(false);
    // The same WebView2 profile as the main window, which a portable copy
    // keeps beside the program.
    if let Some(root) = crate::local_fs::portable::root() {
        builder = builder.data_directory(crate::local_fs::portable::webview_dir(root));
    }
    let main = app.get_webview_window("main");
    // Owned by the main window, so it gets no taskbar button of its own.
    if let Some(main) = &main {
        builder = builder.parent(main)?;
    }
    let window = builder.build()?;
    enable_native_rounding(&window);
    // Moved over the main window before its page loads, so it has taken that
    // monitor's scale by the time it sizes itself to its content.
    if let Some(main) = &main {
        center_over_parent(main, &window);
    }
    Ok(window)
}
