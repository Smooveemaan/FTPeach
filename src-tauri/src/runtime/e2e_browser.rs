//! Desktop test overrides, compiled only with the `smoke-test` feature.

/// The WebView2 arguments for an automated run. They
/// replace wry's defaults, which come first. Every window sharing the WebView2
/// profile has to be created with the same arguments, the confirmation window
/// too. The windows of a run sit off screen (`show_in_background`); without
/// the occlusion switches the page would count as hidden and stop drawing.
pub(crate) fn args() -> Option<String> {
    if !active() {
        return None;
    }
    let mut args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required".to_owned();
    if let Ok(port) = std::env::var("FTPEACH_E2E_CDP_PORT") {
        let port: u16 = port
            .parse()
            .expect("FTPEACH_E2E_CDP_PORT must be a port number");
        args.push_str(&format!(" --remote-debugging-port={port}"));
    }
    Some(args)
}

/// The folder a save dialog answers with while the desktop tests drive the run.
pub(crate) fn save_folder() -> Option<std::path::PathBuf> {
    std::env::var_os("FTPEACH_E2E_SAVE_DIR").map(Into::into)
}

/// The answer to a Choose folder dialog or a key or certificate picker while
/// the desktop tests drive the run: `FTPEACH_E2E_PICK_FILE` names a file
/// holding the path to pick, empty or missing to cancel. `None` outside the
/// tests.
pub(crate) fn picked_path() -> Option<Option<String>> {
    let file = std::env::var_os("FTPEACH_E2E_PICK_FILE")?;
    let picked = std::fs::read_to_string(file).unwrap_or_default();
    let picked = picked.trim();
    Some((!picked.is_empty()).then(|| picked.to_owned()))
}

/// Whether the desktop tests drive this run.
pub(crate) fn active() -> bool {
    std::env::var_os("FTPEACH_E2E_CDP_PORT").is_some()
        || std::env::var_os("FTPEACH_E2E_CONTROL_PORT").is_some()
}

/// Whether to hold back opening `what` outside FTPeach: a program, Explorer or
/// Windows' own Open with chooser would come up on the screen of whoever works
/// at it while the desktop tests drive the run. The log says what was held
/// back, and the tests fail on that line.
pub(crate) fn hold_back_opening(what: &str) -> bool {
    let held = active();
    if held {
        log::warn!("desktop tests: held back opening {what} outside FTPeach");
    }
    held
}

/// Says why FTPeach cannot start in the file `FTPEACH_E2E_MESSAGE_FILE` names,
/// instead of a message box that would take the focus; false without it.
pub(crate) fn say_instead_of_message_box(message: &str) -> bool {
    std::env::var_os("FTPEACH_E2E_MESSAGE_FILE")
        .is_some_and(|file| std::fs::write(file, message).is_ok())
}

/// Shows the main window off every screen and without taking the focus, so a
/// run leaves the desktop to whoever works at it. The tests drive the page
/// over DevTools, which needs neither.
pub(crate) fn show_in_background(window: &tauri::WebviewWindow) {
    let _ = window.set_position(tauri::PhysicalPosition::new(-20_000, -20_000));
    show_without_focus(window);
}

/// Shows a window without activating it. A window that cannot take the focus
/// is shown without being activated, and it is shown through the windowing
/// library rather than around it: a window shown behind its back stays hidden
/// as far as it knows, and a later `hide`, to the tray say, does nothing.
pub(crate) fn show_without_focus(window: &tauri::WebviewWindow) {
    let _ = window.set_focusable(false);
    let _ = window.show();
}
