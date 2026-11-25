use crate::ipc::{CommandError, CommandResult, ErrorCode};

/// Upper bound on clipboard text returned to the renderer (1 MiB of UTF-8).
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// Writes text through GTK on Linux, where WebKit may deny the browser clipboard API.
#[tauri::command]
pub async fn app_write_clipboard_text<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    text: String,
) -> CommandResult<()> {
    if window.label() != "main" {
        return Err(CommandError::new(
            ErrorCode::PermissionDenied,
            "Main window only",
        ));
    }
    if text.contains('\0') {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Clipboard text contains NUL",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                write_text(&text);
                let _ = tx.send(());
            })
            .map_err(anyhow::Error::from)?;
        rx.await.map_err(anyhow::Error::from)?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    Err(CommandError::new(
        ErrorCode::InvalidInput,
        "Native clipboard is Linux-only",
    ))
}

/// Reads plain text from the OS clipboard without triggering a WebView permission prompt.
#[tauri::command]
pub async fn app_read_clipboard_text<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> CommandResult<String> {
    if window.label() != "main" {
        return Err(CommandError::new(
            ErrorCode::PermissionDenied,
            "Main window only",
        ));
    }

    #[cfg(target_os = "windows")]
    let text = tokio::task::spawn_blocking(read_windows_text)
        .await
        .map_err(anyhow::Error::from)??;

    #[cfg(target_os = "linux")]
    let text = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(read_gtk_text());
            })
            .map_err(anyhow::Error::from)?;
        rx.await.map_err(anyhow::Error::from)?
    };

    #[cfg(target_os = "macos")]
    let text = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(read_macos_text());
            })
            .map_err(anyhow::Error::from)?;
        rx.await.map_err(anyhow::Error::from)?
    };

    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Clipboard text is too large",
        ));
    }
    Ok(text)
}

#[cfg(target_os = "windows")]
fn read_windows_text() -> CommandResult<String> {
    use std::time::Duration;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: Constructed only after a successful `OpenClipboard` call on this thread.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    struct GlobalLockGuard(HGLOBAL);
    impl Drop for GlobalLockGuard {
        fn drop(&mut self) {
            // SAFETY: Constructed only after a successful `GlobalLock` on the same `HGLOBAL`.
            unsafe {
                let _ = GlobalUnlock(self.0);
            }
        }
    }

    let mut opened = false;
    for attempt in 0..5 {
        // SAFETY: Passing `None` associates the open clipboard with the current task.
        if unsafe { OpenClipboard(None) }.is_ok() {
            opened = true;
            break;
        }
        if attempt < 4 {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    if !opened {
        return Err(CommandError::new(
            ErrorCode::Internal,
            "Failed to open system clipboard",
        ));
    }
    let _clipboard = ClipboardGuard;

    // SAFETY: Clipboard is open on the current thread.
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
        return Ok(String::new());
    }

    // SAFETY: Clipboard is open on the current thread and `CF_UNICODETEXT` is available.
    let Ok(handle) = (unsafe { GetClipboardData(CF_UNICODETEXT) }) else {
        return Ok(String::new());
    };
    if handle.0.is_null() {
        return Ok(String::new());
    }

    let hglobal = HGLOBAL(handle.0);
    // SAFETY: `hglobal` is a valid global memory handle owned by the open clipboard.
    let byte_len = unsafe { GlobalSize(hglobal) };
    if byte_len < 2 {
        return Ok(String::new());
    }

    // SAFETY: Locking the clipboard's `HGLOBAL` returns a readable pointer valid until `GlobalUnlock`.
    let ptr = unsafe { GlobalLock(hglobal) };
    if ptr.is_null() {
        return Ok(String::new());
    }
    let _lock = GlobalLockGuard(hglobal);

    // Every UTF-16 code unit produces at least 1 UTF-8 byte, so reading at most
    // `MAX_CLIPBOARD_BYTES + 1` units is enough to detect an oversized clipboard
    // without allocating unbounded memory.
    let max_units = (byte_len / 2).min(MAX_CLIPBOARD_BYTES + 1);
    // SAFETY: `ptr` is locked for `byte_len >= max_units * 2` bytes; `CF_UNICODETEXT` is UTF-16.
    let raw = unsafe { std::slice::from_raw_parts(ptr as *const u16, max_units) };
    let len = raw.iter().position(|&unit| unit == 0).unwrap_or(raw.len());
    if len > MAX_CLIPBOARD_BYTES {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Clipboard text is too large",
        ));
    }
    Ok(String::from_utf16_lossy(&raw[..len]))
}

#[cfg(target_os = "linux")]
fn write_text(text: &str) {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.set_text(text);
    clipboard.store();
}

#[cfg(target_os = "linux")]
fn read_gtk_text() -> String {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard
        .wait_for_text()
        .map(|s| s.to_string())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn read_macos_text() -> String {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let pasteboard = NSPasteboard::generalPasteboard();
    // SAFETY: `NSPasteboardTypeString` is a constant AppKit extern symbol.
    pasteboard
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|s| s.to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clipboard_refuses_other_windows_and_nul_before_writing() {
        let app = tauri::test::mock_app();
        for (label, text, expected) in [
            (
                "security-confirmation-test",
                "text",
                ErrorCode::PermissionDenied,
            ),
            ("main", "bad\0text", ErrorCode::InvalidInput),
        ] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            let error = app_write_clipboard_text(window, text.into())
                .await
                .unwrap_err();
            assert_eq!(error.code, expected);
        }
    }

    #[tokio::test]
    async fn clipboard_read_refuses_non_main_windows() {
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "security-confirmation-test",
            Default::default(),
        )
        .build()
        .unwrap();
        let error = app_read_clipboard_text(window).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn gtk_clipboard_preserves_multiline_unicode_and_empty_text() {
        const TEST: &str = "commands::app::clipboard::tests::gtk_clipboard_preserves_multiline_unicode_and_empty_text";
        if crate::test_inputs::linux::run_in_xvfb(TEST, "FTPEACH_CLIPBOARD_TEST_CHILD", true) {
            return;
        }
        gtk::init().unwrap();
        for text in ["/home/user/a b/é.txt\n/other", ""] {
            write_text(text);
            assert_eq!(read_gtk_text(), text);
        }
    }
}
