//! Linux desktop appearance comes from the portal, not the app's GTK preference.

use dbus::{arg::Variant, blocking::Connection, message::MatchRule};
use std::time::Duration;
use tauri::Emitter;

fn theme(value: u32) -> Option<&'static str> {
    match value {
        1 => Some("dark"),
        0 | 2 => Some("light"),
        _ => None,
    }
}

/// Reads the desktop preference without consulting this application's theme override.
pub(crate) fn read() -> Result<Option<&'static str>, dbus::Error> {
    let connection = Connection::new_session()?;
    let proxy = connection.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(2),
    );
    let (value,): (Variant<Variant<u32>>,) = proxy.method_call(
        "org.freedesktop.portal.Settings",
        "Read",
        ("org.freedesktop.appearance", "color-scheme"),
    )?;
    Ok(theme(value.0.0))
}

/// Forwards desktop changes independently of theme changes made by the renderer.
pub(crate) fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = watch(app) {
            log::warn!("System appearance portal unavailable: {error}");
        }
    });
}

fn watch(app: tauri::AppHandle) -> Result<(), dbus::Error> {
    let connection = Connection::new_session()?;
    connection.add_match(
        MatchRule::new_signal("org.freedesktop.portal.Settings", "SettingChanged"),
        move |(namespace, key, value): (String, String, Variant<u32>), _, _| {
            if namespace == "org.freedesktop.appearance"
                && key == "color-scheme"
                && let Some(theme) = theme(value.0)
                && let Err(error) = app.emit("app:system-theme", theme)
            {
                log::warn!("Cannot forward system appearance: {error}");
            }
            true
        },
    )?;
    loop {
        connection.process(Duration::from_secs(5))?;
    }
}

#[cfg(test)]
mod tests {
    use super::theme;

    #[test]
    fn interprets_portal_preferences_and_rejects_unknown_values() {
        assert_eq!(theme(0), Some("light"));
        assert_eq!(theme(1), Some("dark"));
        assert_eq!(theme(2), Some("light"));
        assert_eq!(theme(3), None);
        assert_eq!(theme(u32::MAX), None);
    }
}
