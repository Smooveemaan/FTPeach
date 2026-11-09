//! macOS Dock integration and reopen event handling.
//!
//! On macOS, clicking the application icon in the Dock (or reopening via
//! Finder / Launchpad while the process is running) emits a `Reopen` event.
//! If there are no visible windows (e.g. the window was closed/hidden),
//! the main window is restored and focused. If a window is visible but
//! minimized, it is unminimized and brought to the front.

use tauri::{AppHandle, Manager};

/// What a macOS reopen event requests.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ReopenAction {
    /// Restore the window from hidden/tray state and focus it.
    Restore,
    /// Unminimize and focus an already visible window.
    Focus,
}

/// Decides what action to take when macOS emits a reopen event.
pub fn reopen_action(has_visible_windows: bool) -> ReopenAction {
    if !has_visible_windows {
        ReopenAction::Restore
    } else {
        ReopenAction::Focus
    }
}

/// Sets the application's process and Dock display name at runtime on macOS.
///
/// In dev mode (`npm run tauri dev`), the unbundled binary runs without an
/// `.app` bundle wrapper, so LaunchServices and Dock default to showing the
/// binary filename ("app"). Setting the process name and updating the ASN's
/// display name via LaunchServices ensures macOS displays "FTPeach" in the
/// Dock tooltip and application menu.
#[cfg(target_os = "macos")]
pub fn set_dock_title(name: &str) {
    use std::ffi::c_void;

    // 1. Update Cocoa NSProcessInfo
    objc2_foundation::NSProcessInfo::processInfo()
        .setProcessName(&objc2_foundation::NSString::from_str(name));

    // 2. Update LaunchServices ASN display name (used by Dock and WindowServer)
    type PrivateLSASN = *const c_void;
    type LSGetCurrentApplicationASNType = unsafe extern "C" fn() -> PrivateLSASN;
    type LSSetApplicationInformationItemType = unsafe extern "C" fn(
        i32,
        PrivateLSASN,
        *const c_void,
        *const c_void,
        *mut *const c_void,
    ) -> i32;

    unsafe {
        let handle = libc::dlopen(
            c"/System/Library/Frameworks/CoreServices.framework/CoreServices".as_ptr(),
            libc::RTLD_LAZY,
        );
        if handle.is_null() {
            return;
        }

        let get_asn_sym = libc::dlsym(handle, c"_LSGetCurrentApplicationASN".as_ptr());
        let set_info_sym = libc::dlsym(handle, c"_LSSetApplicationInformationItem".as_ptr());
        let key_sym = libc::dlsym(handle, c"_kLSDisplayNameKey".as_ptr());

        if !get_asn_sym.is_null() && !set_info_sym.is_null() && !key_sym.is_null() {
            let get_asn: LSGetCurrentApplicationASNType = std::mem::transmute(get_asn_sym);
            let set_info: LSSetApplicationInformationItemType = std::mem::transmute(set_info_sym);
            let key = *(key_sym as *const *const c_void);

            let asn = get_asn();
            if !asn.is_null() {
                let ns_name = objc2_foundation::NSString::from_str(name);
                let cf_name = std::ptr::from_ref(&*ns_name).cast::<c_void>();
                let _ = set_info(-2, asn, key, cf_name, std::ptr::null_mut());
            }
        }
    }
}

/// Handles `tauri::RunEvent::Reopen` on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn handle_reopen(app: &AppHandle, has_visible_windows: bool) {
    match reopen_action(has_visible_windows) {
        ReopenAction::Restore => {
            crate::runtime::tray::restore(app);
        }
        ReopenAction::Focus => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopen_action_restores_when_no_visible_windows() {
        assert_eq!(reopen_action(false), ReopenAction::Restore);
    }

    #[test]
    fn reopen_action_focuses_when_windows_are_visible() {
        assert_eq!(reopen_action(true), ReopenAction::Focus);
    }
}
