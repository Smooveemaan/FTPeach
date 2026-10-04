//! Keep the main WebView's native container aligned before WRY updates WebView2,
//! and keep a lone Alt from putting the main window into menu mode.

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetParent, IsIconic, SC_KEYMENU, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SetWindowPos, WINDOWPOS, WM_NCDESTROY, WM_SYSCOMMAND, WM_WINDOWPOSCHANGED,
};

const SUBCLASS_ID: usize = 0x4654_5052;

/// Installs the main-window-only sizing hook on the window's UI thread.
pub(crate) fn install(window: &tauri::WebviewWindow) {
    if let Err(error) = window.with_webview(|webview| {
        let result = unsafe {
            let mut child = HWND::default();
            webview
                .controller()
                .ParentWindow(&mut child)
                .and_then(|()| GetParent(child))
                .and_then(|parent| attach(parent, child))
        };
        if let Err(error) = result {
            log::warn!("Could not install the native WebView sizing hook: {error}");
        }
    }) {
        log::warn!("Could not reach the WebView UI thread for its sizing hook: {error}");
    }
}

// Both handles must belong to this thread. The subclass borrows the child handle;
// it owns no COM object or allocation, and checks parentage before each resize.
unsafe fn attach(parent: HWND, child: HWND) -> windows::core::Result<()> {
    unsafe { SetWindowSubclass(parent, Some(resize_proc), SUBCLASS_ID, child.0 as usize).ok() }
}

unsafe extern "system" fn resize_proc(
    parent: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    child: usize,
) -> LRESULT {
    // Win32 owns WINDOWPOS for this synchronous notification. Forwarding the
    // message is essential: DefWindowProc generates WRY/Tao's normal WM_SIZE.
    unsafe {
        if message == WM_WINDOWPOSCHANGED && lparam.0 != 0 {
            let position = &*(lparam.0 as *const WINDOWPOS);
            let child = HWND(child as *mut std::ffi::c_void);
            if !position.flags.contains(SWP_NOSIZE)
                && !IsIconic(parent).as_bool()
                && GetParent(child).is_ok_and(|owner| owner == parent)
            {
                let mut bounds = RECT::default();
                if GetClientRect(parent, &mut bounds).is_ok() {
                    // Align the container before WRY updates the controller in WM_SIZE.
                    let _ = SetWindowPos(
                        child,
                        None,
                        0,
                        0,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
            }
        } else if message == WM_SYSCOMMAND
            && (wparam.0 & 0xFFF0) as u32 == SC_KEYMENU
            && keeps_key_menu_closed(lparam.0, mouse_button_held())
        {
            return LRESULT(0);
        } else if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(parent, Some(resize_proc), subclass_id);
        }
        DefSubclassProc(parent, message, wparam, lparam)
    }
}

/// The system menu's modal loop, entered from the keyboard, holds the mouse:
/// no clicks and no Alt+Tab until the app is killed. A lone Alt (lparam 0)
/// would enter it with nothing to show, since the window draws its own title
/// bar; during a drag from Explorer, a mouse button held, even Alt+Space
/// would, as the menu's loop and the drag's lock each other. Alt+Space
/// otherwise still opens the system menu.
fn keeps_key_menu_closed(lparam: isize, mouse_button_held: bool) -> bool {
    lparam == 0 || mouse_button_held
}

fn mouse_button_held() -> bool {
    // Physical buttons, so a swapped mouse is covered by asking for both.
    [VK_LBUTTON, VK_RBUTTON]
        .iter()
        .any(|key| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WM_SIZE, WS_CHILD, WS_OVERLAPPEDWINDOW,
    };
    use windows::core::w;

    struct TestWindow(HWND);
    impl Drop for TestWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }

    struct Probe {
        child: HWND,
        aligned_during_size: Cell<bool>,
    }

    unsafe extern "system" fn observe_size(
        parent: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        unsafe {
            if message == WM_SIZE {
                let probe = &*(data as *const Probe);
                let mut outer = RECT::default();
                let mut inner = RECT::default();
                let aligned = GetClientRect(parent, &mut outer).is_ok()
                    && GetClientRect(probe.child, &mut inner).is_ok()
                    && outer == inner;
                probe.aligned_during_size.set(aligned);
            }
            DefSubclassProc(parent, message, wparam, lparam)
        }
    }

    unsafe extern "system" fn observe_syscommand(
        parent: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        unsafe {
            if message == WM_SYSCOMMAND {
                (*(data as *const Cell<u32>)).set((wparam.0 & 0xFFF0) as u32);
            }
            DefSubclassProc(parent, message, wparam, lparam)
        }
    }

    #[test]
    fn a_lone_alt_does_not_reach_the_system_menu() {
        use windows::Win32::UI::WindowsAndMessaging::{SC_RESTORE, SendMessageW};
        let seen = Box::new(Cell::new(0u32));
        unsafe {
            let parent = TestWindow(
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("alt-test"),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    640,
                    480,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("create hidden parent"),
            );
            // Installed first, so it runs after the hook under test.
            SetWindowSubclass(
                parent.0,
                Some(observe_syscommand),
                1,
                (&*seen as *const Cell<u32>) as usize,
            )
            .ok()
            .expect("attach observer");
            attach(parent.0, HWND::default()).expect("attach hook");

            SendMessageW(
                parent.0,
                WM_SYSCOMMAND,
                Some(WPARAM(SC_KEYMENU as usize)),
                Some(LPARAM(0)),
            );
            assert_eq!(seen.get(), 0, "a lone Alt went on to the system menu");
            SendMessageW(
                parent.0,
                WM_SYSCOMMAND,
                Some(WPARAM(SC_RESTORE as usize)),
                Some(LPARAM(0)),
            );
            assert_eq!(
                seen.get(),
                SC_RESTORE,
                "other system commands still go through"
            );
        }
        assert!(
            !keeps_key_menu_closed(' ' as isize, false),
            "Alt+Space opens the menu"
        );
        assert!(
            keeps_key_menu_closed(' ' as isize, true),
            "not while a drag holds a button"
        );
    }

    #[test]
    fn container_matches_client_before_downstream_size_handler() {
        // State outlives the hidden parent and its borrowed subclass pointer.
        let mut probe = Box::new(Probe {
            child: HWND::default(),
            aligned_during_size: Cell::new(false),
        });
        unsafe {
            let parent = TestWindow(
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("resize-test"),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    640,
                    480,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("create hidden parent"),
            );
            probe.child = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("child"),
                WS_CHILD,
                0,
                0,
                1,
                1,
                Some(parent.0),
                None,
                None,
                None,
            )
            .expect("create child");
            SetWindowSubclass(
                parent.0,
                Some(observe_size),
                1,
                (&*probe as *const Probe) as usize,
            )
            .ok()
            .expect("attach observer");

            // A normal parent resize alone does not align the child.
            SetWindowPos(
                parent.0,
                None,
                0,
                0,
                700,
                500,
                SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .expect("resize baseline");
            assert!(!probe.aligned_during_size.get());

            attach(parent.0, probe.child).expect("attach sizing hook");
            SetWindowPos(
                parent.0,
                None,
                0,
                0,
                800,
                600,
                SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .expect("resize with hook");
            assert!(probe.aligned_during_size.get());
        }
    }
}
