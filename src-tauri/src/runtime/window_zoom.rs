//! Smooth window zoom animation for macOS.
//!
//! Intercepts `windowShouldZoom:toFrame:` on the main window's delegate to
//! prevent AppKit's legacy synchronous blocking animation (`[window setFrame:... animate:YES]`).
//! Drives the resize asynchronously via Core Animation (`NSAnimationContext` + `window.animator().setFrame:`),
//! allowing WKWebView to continuously receive viewport updates and reflow content during zoom.

use std::ffi::{c_char, c_void};
use std::sync::Once;
use tauri::WebviewWindow;

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct NSPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct NSSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct NSRect {
    pub origin: NSPoint,
    pub size: NSSize,
}

struct ZoomContext {
    window: *mut c_void,
    target_frame: NSRect,
}

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn objc_getClass(name: *const c_char) -> *const c_void;
    fn object_getClass(obj: *const c_void) -> *mut c_void;
    fn class_getInstanceMethod(cls: *const c_void, name: *const c_void) -> *const c_void;
    fn class_addMethod(
        cls: *mut c_void,
        name: *const c_void,
        imp: *const (),
        types: *const c_char,
    ) -> u8;
}

unsafe extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: unsafe extern "C" fn(*mut c_void),
    );
}

static HOOK_INIT: Once = Once::new();

/// Installs the smooth zoom handler on the window's Cocoa delegate.
pub(crate) fn install(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let Ok(ns_window_ptr) = window.ns_window() else {
            log::warn!("Could not obtain NSWindow for smooth zoom hook");
            return;
        };

        if ns_window_ptr.is_null() {
            return;
        }

        HOOK_INIT.call_once(|| unsafe {
            install_hook(ns_window_ptr);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "macos")]
unsafe fn install_hook(ns_window: *mut c_void) {
    let sel_delegate = unsafe { sel_registerName(c"delegate".as_ptr()) };
    let msg_send_delegate: unsafe extern "C" fn(*const c_void, *const c_void) -> *mut c_void =
        unsafe { std::mem::transmute(libc::dlsym(libc::RTLD_DEFAULT, c"objc_msgSend".as_ptr())) };
    let delegate = unsafe { msg_send_delegate(ns_window, sel_delegate) };
    if delegate.is_null() {
        log::warn!("NSWindow delegate is null; cannot install smooth zoom hook");
        return;
    }

    let delegate_class = unsafe { object_getClass(delegate) };
    if delegate_class.is_null() {
        log::warn!("NSWindow delegate class is null");
        return;
    }

    let sel_should_zoom = unsafe { sel_registerName(c"windowShouldZoom:toFrame:".as_ptr()) };
    let existing_method = unsafe { class_getInstanceMethod(delegate_class, sel_should_zoom) };
    if !existing_method.is_null() {
        log::debug!("windowShouldZoom:toFrame: is already implemented on delegate class");
        return;
    }

    let types = c"c@:@{CGRect={CGPoint=dd}{CGSize=dd}}";
    let added = unsafe {
        class_addMethod(
            delegate_class,
            sel_should_zoom,
            window_should_zoom as *const (),
            types.as_ptr(),
        )
    };

    if added != 0 {
        log::info!("Installed smooth zoom hook on NSWindow delegate");
    } else {
        log::warn!("Failed to install windowShouldZoom:toFrame: on NSWindow delegate");
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn window_should_zoom(
    _this: *mut c_void,
    _cmd: *mut c_void,
    ns_window: *mut c_void,
    new_frame: NSRect,
) -> i8 {
    let payload = Box::into_raw(Box::new(ZoomContext {
        window: ns_window,
        target_frame: new_frame,
    }));

    unsafe {
        dispatch_async_f(
            &_dispatch_main_q as *const c_void,
            payload as *mut c_void,
            perform_animated_zoom,
        );
    }

    0 // NO: Suppress AppKit's synchronous blocking animation
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn perform_animated_zoom(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let payload = unsafe { Box::from_raw(context as *mut ZoomContext) };
    let window = payload.window;
    let target_frame = payload.target_frame;

    unsafe {
        animate_window_to_frame(window, target_frame);
    }
}

#[cfg(target_os = "macos")]
unsafe fn animate_window_to_frame(window: *mut c_void, target_frame: NSRect) {
    let objc_msg_send = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"objc_msgSend".as_ptr()) };
    if objc_msg_send.is_null() {
        return;
    }

    // Determine animation duration: [window animationResizeTime:target_frame]
    let sel_resize_time = unsafe { sel_registerName(c"animationResizeTime:".as_ptr()) };
    let msg_send_resize_time: unsafe extern "C" fn(*const c_void, *const c_void, NSRect) -> f64 =
        unsafe { std::mem::transmute(objc_msg_send) };
    let mut duration = unsafe { msg_send_resize_time(window, sel_resize_time, target_frame) };
    if duration <= 0.0 || duration.is_nan() {
        duration = 0.22;
    }

    let cls_anim_context = unsafe { objc_getClass(c"NSAnimationContext".as_ptr()) };
    let cls_timing_function = unsafe { objc_getClass(c"CAMediaTimingFunction".as_ptr()) };

    if cls_anim_context.is_null() {
        // Fallback: direct setFrame
        let sel_set_frame = unsafe { sel_registerName(c"setFrame:display:".as_ptr()) };
        let msg_send_set_frame: unsafe extern "C" fn(*const c_void, *const c_void, NSRect, u8) =
            unsafe { std::mem::transmute(objc_msg_send) };
        unsafe { msg_send_set_frame(window, sel_set_frame, target_frame, 1) };
        return;
    }

    let sel_begin_grouping = unsafe { sel_registerName(c"beginGrouping".as_ptr()) };
    let sel_end_grouping = unsafe { sel_registerName(c"endGrouping".as_ptr()) };
    let sel_current_context = unsafe { sel_registerName(c"currentContext".as_ptr()) };
    let sel_set_duration = unsafe { sel_registerName(c"setDuration:".as_ptr()) };
    let sel_set_timing = unsafe { sel_registerName(c"setTimingFunction:".as_ptr()) };
    let sel_set_allows_implicit =
        unsafe { sel_registerName(c"setAllowsImplicitAnimation:".as_ptr()) };
    let sel_animator = unsafe { sel_registerName(c"animator".as_ptr()) };
    let sel_set_frame = unsafe { sel_registerName(c"setFrame:display:".as_ptr()) };

    let msg_send_void: unsafe extern "C" fn(*const c_void, *const c_void) =
        unsafe { std::mem::transmute(objc_msg_send) };
    let msg_send_id: unsafe extern "C" fn(*const c_void, *const c_void) -> *mut c_void =
        unsafe { std::mem::transmute(objc_msg_send) };
    let msg_send_set_duration: unsafe extern "C" fn(*const c_void, *const c_void, f64) =
        unsafe { std::mem::transmute(objc_msg_send) };
    let msg_send_set_id: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void) =
        unsafe { std::mem::transmute(objc_msg_send) };
    let msg_send_set_bool: unsafe extern "C" fn(*const c_void, *const c_void, u8) =
        unsafe { std::mem::transmute(objc_msg_send) };
    let msg_send_set_frame: unsafe extern "C" fn(*const c_void, *const c_void, NSRect, u8) =
        unsafe { std::mem::transmute(objc_msg_send) };

    // [NSAnimationContext beginGrouping]
    unsafe { msg_send_void(cls_anim_context, sel_begin_grouping) };

    let context = unsafe { msg_send_id(cls_anim_context, sel_current_context) };
    if !context.is_null() {
        unsafe {
            msg_send_set_duration(context, sel_set_duration, duration);
            msg_send_set_bool(context, sel_set_allows_implicit, 1);
        }

        if !cls_timing_function.is_null() {
            let sel_function_name = unsafe { sel_registerName(c"functionWithName:".as_ptr()) };
            let cf_ease = unsafe {
                CFStringCreateWithCString(
                    std::ptr::null(),
                    c"easeInEaseOut".as_ptr(),
                    0x08000100, // kCFStringEncodingUTF8
                )
            };
            if !cf_ease.is_null() {
                let msg_send_timing: unsafe extern "C" fn(
                    *const c_void,
                    *const c_void,
                    *const c_void,
                ) -> *mut c_void = unsafe { std::mem::transmute(objc_msg_send) };
                let timing =
                    unsafe { msg_send_timing(cls_timing_function, sel_function_name, cf_ease) };
                if !timing.is_null() {
                    unsafe { msg_send_set_id(context, sel_set_timing, timing) };
                }
                unsafe { CFRelease(cf_ease) };
            }
        }
    }

    // id animator = [window animator];
    let animator = unsafe { msg_send_id(window, sel_animator) };
    let target = if !animator.is_null() {
        animator
    } else {
        window
    };

    // [animator setFrame:target_frame display:YES]
    unsafe { msg_send_set_frame(target, sel_set_frame, target_frame, 1) };

    // [NSAnimationContext endGrouping]
    unsafe { msg_send_void(cls_anim_context, sel_end_grouping) };
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CFStringCreateWithCString(
        alloc: *const c_void,
        c_str: *const c_char,
        encoding: u32,
    ) -> *const c_void;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_struct_layout_matches_apple_abi() {
        assert_eq!(std::mem::size_of::<NSPoint>(), 16);
        assert_eq!(std::mem::size_of::<NSSize>(), 16);
        assert_eq!(std::mem::size_of::<NSRect>(), 32);
    }
}
