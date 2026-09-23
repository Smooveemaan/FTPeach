//! Whether the Windows desktop session is locked.
//!
//! The vault's auto-lock asks this instead of trusting the renderer's
//! `visibilitychange`: a WebView that has stopped running its event loop
//! reports nothing at all, and a secure-desktop switch is exactly the moment
//! the vault must not stay open.
//!
//! This polls rather than subscribing to `WM_WTSSESSION_CHANGE`, because
//! receiving that message means owning a window procedure, and Tauri owns
//! the only window this process has. The auto-lock already runs on a timer,
//! so a query costs one call per tick.

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

#[cfg(not(windows))]
pub fn session_locked() -> Option<bool> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A developer machine running the suite is unlocked, and more to the
    /// point the query has to answer at all: a `None` here would silently
    /// reduce the auto-lock to its idle timer.
    #[test]
    fn the_session_state_can_be_read_on_this_machine() {
        assert_eq!(session_locked(), Some(false));
    }
}
