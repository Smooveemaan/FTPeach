use crate::ipc::{CommandError, CommandResult, ErrorCode};

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

#[cfg(target_os = "linux")]
fn write_text(text: &str) {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.set_text(text);
    clipboard.store();
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

    #[cfg(target_os = "linux")]
    #[test]
    fn gtk_clipboard_preserves_multiline_unicode_and_empty_text() {
        const TEST: &str = "commands::app::clipboard::tests::gtk_clipboard_preserves_multiline_unicode_and_empty_text";
        if std::env::var_os("FTPEACH_CLIPBOARD_TEST_CHILD").is_none() {
            let output = std::process::Command::new("xvfb-run")
                .args(["-a"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env("FTPEACH_CLIPBOARD_TEST_CHILD", "1")
                .env("GDK_BACKEND", "x11")
                .env_remove("WAYLAND_DISPLAY")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        gtk::init().unwrap();
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        for text in ["/home/user/a b/é.txt\n/other", ""] {
            write_text(text);
            assert_eq!(clipboard.wait_for_text().as_deref(), Some(text));
        }
    }
}
