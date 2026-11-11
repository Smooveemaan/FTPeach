//! WebView2's browser shortcuts and context menus in FTPeach's windows.

/// Turns off WebView2's browser shortcuts and default context menus.
pub(crate) fn disable(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };
        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
    });
}
