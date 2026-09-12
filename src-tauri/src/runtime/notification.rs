//! The system notification FTPeach shows when its transfer queue drains.
//!
//! Windows attributes every toast to an [AppUserModelID][1], and an
//! unpackaged desktop app has to supply that id twice over: the toast is sent
//! through a notifier created with it, and the name and icon Windows draws in
//! the toast header come from that id's registration under
//! `HKCU\Software\Classes\AppUserModelId`. Miss either half and the toast
//! still appears, wearing somebody else's identity.
//!
//! Both halves were missing. `tauri-plugin-notification` skips the app id
//! whenever the running exe sits in `target/debug` or `target/release`, and
//! `tauri-winrt-notification` then falls back to a stock PowerShell id — so a
//! `npm run dev` FTPeach announced its finished transfers as "Windows
//! PowerShell", PowerShell icon included. An installed build passed the id
//! along but never registered it, leaving Windows nothing to draw.
//!
//! So Windows gets its own path here: [`register_identity`] writes the
//! registration at startup and [`show`] sends the toast under the same id.
//! Every other platform keeps the plugin, which is correct there.
//!
//! [1]: https://learn.microsoft.com/en-us/windows/win32/shell/appids
use tauri::AppHandle;

/// Must stay equal to `identifier` in `tauri.conf.json` — the installed app's
/// identity is derived from that field, and a toast sent under any other id is
/// one Windows cannot tie back to FTPeach. `notification_tests` holds the two
/// together.
pub const APP_USER_MODEL_ID: &str = "com.smooveemaan.ftpeach";

/// The icon Windows puts on the toast, as it is named among the bundle
/// resources in `tauri.conf.json`. It has to be a file on disk rather than the
/// icon compiled into the exe, because the registration below points at it by
/// path.
///
/// It is the multi-resolution `.ico` rather than one large `.png`, and that is
/// the difference between a crisp icon and a smeared one. Windows draws this
/// at roughly 16-24 px; handed a single 256 px bitmap it shrinks the image
/// itself, and that reduction breaks the peach's thin outline into speckles.
/// The tray reads the very same `.ico` — on Windows it is what Tauri embeds as
/// the default window icon — and picks the purpose-drawn entry for the size it
/// needs, which is why the tray stayed sharp while the toast did not.
pub const ICON_RESOURCE: &str = "icons/app-icon.ico";

/// Teaches Windows who [`APP_USER_MODEL_ID`] is, so the toast carries
/// FTPeach's name and icon instead of an anonymous or borrowed identity.
///
/// Best-effort by design: a machine that refuses the write still gets its
/// notifications, just plainer ones, which is no reason to fail startup.
#[cfg(windows)]
pub fn register_identity(app: &AppHandle) {
    use tauri::Manager;
    use tauri::path::BaseDirectory;

    let path = format!("Software\\Classes\\AppUserModelId\\{APP_USER_MODEL_ID}");
    let key = match windows_registry::CURRENT_USER.create(&path) {
        Ok(key) => key,
        Err(error) => {
            log::warn!("could not register the notification identity: {error}");
            return;
        }
    };
    if let Err(error) = key.set_string("DisplayName", "FTPeach") {
        log::warn!("could not name FTPeach on its notifications: {error}");
    }
    // Without this the app is missing from Settings > Notifications, which is
    // where a user who wants FTPeach quiet at the OS level goes looking.
    if let Err(error) = key.set_u32("ShowInSettings", 1) {
        log::warn!("could not list FTPeach in the notification settings: {error}");
    }
    match app.path().resolve(ICON_RESOURCE, BaseDirectory::Resource) {
        Ok(icon) => {
            if let Err(error) = key.set_string("IconUri", icon_uri(&icon)) {
                log::warn!("could not set the notification icon: {error}");
            }
        }
        Err(error) => log::warn!("could not locate the notification icon: {error}"),
    }
}

/// Tauri resolves resources to a canonicalized path, which on Windows carries
/// the `\\?\` verbatim prefix. The shell reads `IconUri` with its ordinary
/// path handling and draws no icon at all for a prefixed one, so it comes off
/// here.
#[cfg(windows)]
fn icon_uri(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[cfg(not(windows))]
pub fn register_identity(_app: &AppHandle) {}

/// Shows the toast. `title` and `body` arrive already localized.
#[cfg(windows)]
pub fn show(_app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, Toast};

    Toast::new(APP_USER_MODEL_ID)
        .title(title)
        .text1(body)
        .duration(Duration::Short)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "notification_tests.rs"]
mod tests;
