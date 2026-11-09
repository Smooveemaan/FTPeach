//! Whether the desktop session is locked (Windows and macOS).
//!
//! The vault's auto-lock asks this instead of trusting the renderer's
//! `visibilitychange`: a WebView that has stopped running its event loop
//! reports nothing at all, and a secure-desktop switch or screen lock is
//! exactly the moment the vault must not stay open.
//!
//! This polls rather than subscribing to OS session notification events,
//! because handling them requires window procedures or run-loop hooks that
//! are owned by Tauri. The auto-lock already runs on a timer, so a query
//! costs one call per tick.

/// The key in the macOS CoreGraphics session dictionary indicating whether
/// the screen is currently locked.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[allow(dead_code)]
pub const CGS_SESSION_SCREEN_IS_LOCKED: &str = "CGSSessionScreenIsLocked";

/// Interprets the screen lock state from whether `CGSSessionScreenIsLocked` was
/// found in the session dictionary and what boolean value it carried.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_session_locked(key_present: bool, boolean_value: Option<bool>) -> bool {
    key_present && boolean_value.unwrap_or(false)
}

/// `Some(true)` when the session is locked, `Some(false)` when it is not,
/// and `None` when the platform cannot say. Callers must treat `None` as
/// "not locked" and fall back to the idle timeout.
#[cfg(windows)]
pub fn session_locked() -> Option<bool> {
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK, WTSFreeMemory, WTSINFOEXW,
        WTSQuerySessionInformationW, WTSSessionInfoEx,
    };
    use windows_core::PWSTR;

    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: the call fills `buffer` with a WTSINFOEXW that the same API
    // frees; nothing else is passed in and the buffer is not used after the
    // free. A null server handle means this server, as documented.
    unsafe {
        WTSQuerySessionInformationW(
            None,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
        .ok()?;
        if buffer.is_null() || (bytes as usize) < size_of::<WTSINFOEXW>() {
            WTSFreeMemory(buffer.as_ptr().cast());
            return None;
        }
        let info = buffer.as_ptr().cast::<WTSINFOEXW>().read_unaligned();
        WTSFreeMemory(buffer.as_ptr().cast());
        // Level 1 is the only level this structure has ever defined; a
        // future one would describe a different union member.
        if info.Level != 1 {
            return None;
        }
        Some(info.Data.WTSInfoExLevel1.SessionFlags as u32 == WTS_SESSIONSTATE_LOCK)
    }
}

#[cfg(target_os = "macos")]
pub fn session_locked() -> Option<bool> {
    macos::session_locked()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
        fn CFDictionaryGetValueIfPresent(
            the_dict: *const c_void,
            key: *const c_void,
            value: *mut *const c_void,
        ) -> u8;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const std::ffi::c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(boolean: *const c_void) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;

    pub fn session_locked() -> Option<bool> {
        // SAFETY: CGSessionCopyCurrentDictionary returns a retained CFDictionaryRef
        // (Create Rule) or null if no graphical Aqua session exists. We release it
        // before returning.
        let dict = unsafe { CGSessionCopyCurrentDictionary() };
        if dict.is_null() {
            return None;
        }

        // SAFETY: CFStringCreateWithCString creates an immutable CFStringRef
        // from a null-terminated C string literal. We release it before returning.
        let key = unsafe {
            CFStringCreateWithCString(
                std::ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if key.is_null() {
            // SAFETY: dict was checked non-null above.
            unsafe { CFRelease(dict) };
            return None;
        }

        let mut val_ptr: *const c_void = std::ptr::null();
        // SAFETY: CFDictionaryGetValueIfPresent is called with valid dictionary and key pointers.
        let present = unsafe { CFDictionaryGetValueIfPresent(dict, key, &mut val_ptr) } != 0;

        let bool_val = if present && !val_ptr.is_null() {
            // SAFETY: val_ptr is checked non-null and verified against CFBooleanGetTypeID.
            let is_bool = unsafe { CFGetTypeID(val_ptr) == CFBooleanGetTypeID() };
            if is_bool {
                // SAFETY: val_ptr is verified to be a CFBooleanRef.
                Some(unsafe { CFBooleanGetValue(val_ptr) } != 0)
            } else {
                None
            }
        } else {
            None
        };

        // SAFETY: key and dict were successfully allocated and are released here.
        unsafe {
            CFRelease(key);
            CFRelease(dict);
        }

        Some(is_session_locked(present, bool_val))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn session_locked() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cgs_session_screen_is_locked_key_is_accurate() {
        assert_eq!(CGS_SESSION_SCREEN_IS_LOCKED, "CGSSessionScreenIsLocked");
    }

    #[test]
    fn screen_locked_when_key_is_present_and_true() {
        assert!(is_session_locked(true, Some(true)));
    }

    #[test]
    fn screen_unlocked_when_key_is_present_and_false() {
        assert!(!is_session_locked(true, Some(false)));
    }

    #[test]
    fn screen_unlocked_when_key_is_absent() {
        assert!(!is_session_locked(false, None));
        assert!(!is_session_locked(false, Some(true)));
    }

    #[test]
    fn screen_unlocked_when_value_is_invalid() {
        assert!(!is_session_locked(true, None));
    }

    #[cfg(windows)]
    #[test]
    fn the_session_state_can_be_read_on_this_machine() {
        assert_eq!(session_locked(), Some(false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_session_state_can_be_read_on_this_machine() {
        assert_eq!(session_locked(), Some(false));
    }
}
