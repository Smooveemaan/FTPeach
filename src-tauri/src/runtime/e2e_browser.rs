//! The desktop tests (test/e2e) attach to the test build over the DevTools
//! protocol. Only a build with the `smoke-test` feature compiles this, and it
//! listens only when the tests name a port.

/// The WebView2 arguments when `FTPEACH_E2E_CDP_PORT` names a port. They
/// replace wry's defaults, which come first. Every window sharing the WebView2
/// profile has to be created with the same arguments, the confirmation window
/// too. The windows of a run sit off screen (`show_in_background`); without
/// the occlusion switches the page would count as hidden and stop drawing.
pub(crate) fn args() -> Option<String> {
    let port: u16 = std::env::var("FTPEACH_E2E_CDP_PORT")
        .ok()?
        .parse()
        .expect("FTPEACH_E2E_CDP_PORT must be a port number");
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required --remote-debugging-port={port}"
    ))
}

/// Whether the desktop tests drive this run.
pub(crate) fn active() -> bool {
    std::env::var_os("FTPEACH_E2E_CDP_PORT").is_some()
}

/// Shows the main window off every screen and without taking the focus, so a
/// run leaves the desktop to whoever works at it. The tests drive the page
/// over DevTools, which needs neither.
pub(crate) fn show_in_background(window: &tauri::WebviewWindow) {
    let _ = window.set_position(tauri::PhysicalPosition::new(-20_000, -20_000));
    show_without_focus(window);
}

/// Shows a window without activating it.
pub(crate) fn show_without_focus(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindow},
        };
        let Ok(handle) = window.window_handle() else {
            return;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return;
        };
        // SAFETY: the handle belongs to this live window.
        unsafe {
            let _ = ShowWindow(
                HWND(handle.hwnd.get() as *mut std::ffi::c_void),
                SW_SHOWNOACTIVATE,
            );
        }
    }
}
