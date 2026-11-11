//! Tracks Linux notifications and their Wayland activation tokens on one D-Bus connection.

use anyhow::{Context, Result};
use gtk::prelude::GtkWindowExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Manager};
use zbus::{
    blocking::{Connection, MessageIterator},
    zvariant::Value,
};

const DESTINATION: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const DESKTOP_ENTRY: &str = "FTPeach";

#[derive(Default)]
struct Notifications(Mutex<Option<Arc<Client>>>);

struct Client {
    connection: Connection,
    shown: Arc<Mutex<HashMap<u32, Option<String>>>>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Client {
    fn new(
        connection: Connection,
        on_click: impl Fn(Option<String>) + Send + 'static,
    ) -> Result<Arc<Self>> {
        let shown = Arc::new(Mutex::new(HashMap::<u32, Option<String>>::new()));
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(DESTINATION)?
            .path(PATH)?
            .interface(DESTINATION)?
            .build();
        let signals = MessageIterator::for_match_rule(rule, &connection, None)?;
        let client = Arc::new(Self { connection, shown });
        let weak = Arc::downgrade(&client);
        std::thread::Builder::new()
            .name("linux-notifications".into())
            .spawn(move || {
                for signal in signals {
                    let (Some(client), Ok(signal)) = (weak.upgrade(), signal) else {
                        return;
                    };
                    let header = signal.header();
                    match header.member().map(|member| member.as_str()) {
                        Some("ActivationToken") => {
                            if let Ok((id, token)) = signal.body().deserialize::<(u32, String)>()
                                && let Some(saved) = lock(&client.shown).get_mut(&id)
                            {
                                *saved = Some(token);
                            }
                        }
                        Some("ActionInvoked") => {
                            if let Ok((id, action)) = signal.body().deserialize::<(u32, String)>() {
                                let token = lock(&client.shown).get(&id).cloned();
                                if action == "default"
                                    && let Some(token) = token
                                {
                                    on_click(token);
                                }
                            }
                        }
                        Some("NotificationClosed") => {
                            if let Ok((id, _reason)) = signal.body().deserialize::<(u32, u32)>() {
                                lock(&client.shown).remove(&id);
                            }
                        }
                        _ => {}
                    }
                }
            })?;
        Ok(client)
    }

    fn show(&self, title: &str, body: &str, icon: &str) -> Result<()> {
        let hints = HashMap::from([("desktop-entry", Value::from(DESKTOP_ENTRY))]);
        // Record the returned id before the listener can consume an immediate click.
        let mut shown = lock(&self.shown);
        let id: u32 = self
            .connection
            .call_method(
                Some(DESTINATION),
                PATH,
                Some(DESTINATION),
                "Notify",
                &(
                    DESKTOP_ENTRY,
                    0u32,
                    icon,
                    title,
                    body,
                    vec!["default", ""],
                    hints,
                    -1i32,
                ),
            )?
            .body()
            .deserialize()?;
        shown.insert(id, None);
        Ok(())
    }

    fn clear(&self) -> Result<()> {
        let ids = lock(&self.shown).keys().copied().collect::<Vec<_>>();
        for id in ids {
            self.connection.call_method(
                Some(DESTINATION),
                PATH,
                Some(DESTINATION),
                "CloseNotification",
                &(id,),
            )?;
        }
        Ok(())
    }
}

/// Installs the state shared by delivered Linux notifications.
pub fn register_identity(app: &AppHandle) {
    app.manage(Notifications::default());
}

/// Delivers a transfer notification with its desktop identity and activation action.
pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    let state = app.state::<Notifications>();
    let mut client = lock(&state.0);
    let result = (|| -> Result<()> {
        if client.is_none() {
            let app = app.clone();
            *client = Some(Client::new(Connection::session()?, move |token| {
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Some(window) = handle.get_webview_window("main")
                        && let Some(token) = token
                        && let Ok(window) = window.gtk_window()
                    {
                        window.set_startup_id(&token);
                    }
                    super::handle_notification_action(&handle);
                }) {
                    log::warn!("could not activate the notification window: {error}");
                }
            })?);
        }
        let active = client
            .as_ref()
            .context("notification connection unavailable")?
            .clone();
        drop(client);
        let icon = app
            .path()
            .resolve("icons/app-icon.png", tauri::path::BaseDirectory::Resource)?;
        active.show(title, body, &icon.to_string_lossy())
    })();
    result.map_err(|error| error.to_string())
}

/// Dismisses this application's notifications when its main window gains focus.
pub fn clear_delivered(app: &AppHandle) {
    let client = lock(&app.state::<Notifications>().0).clone();
    if let Some(client) = client {
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = client.clear() {
                log::warn!("could not clear delivered notifications: {error}");
            }
        });
    }
}

#[cfg(test)]
mod tests;
