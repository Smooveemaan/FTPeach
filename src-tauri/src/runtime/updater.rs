//! Keeping FTPeach current without asking the user to look after it.
//!
//! The check starts with the process rather than with the UI, a found update
//! downloads at once, and the installer then waits in `update_staging` until
//! the next launch installs it -- or until the user asks for it sooner.

use super::shutdown::{self, ShutdownCoordinator};
use super::update_staging::{self, StagedUpdate};
use crate::store::Store;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Default)]
pub struct UpdaterState {
    /// A check or download is running. A second request does not start
    /// another; its caller learns the outcome from the status events.
    busy: AtomicBool,
    /// The last status sent, for a UI that subscribes after it went out.
    status: Mutex<Option<UpdaterStatus>>,
    available: AsyncMutex<Option<Update>>,
    /// The version this session downloaded and staged.
    downloaded: Mutex<Option<String>>,
}

impl UpdaterState {
    pub fn status(&self) -> Option<UpdaterStatus> {
        self.status.lock().ok().and_then(|status| status.clone())
    }

    fn downloaded(&self) -> Option<String> {
        self.downloaded
            .lock()
            .ok()
            .and_then(|version| version.clone())
    }

    fn set_downloaded(&self, version: Option<String>) {
        if let Ok(mut downloaded) = self.downloaded.lock() {
            *downloaded = version;
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "state")]
pub enum UpdaterStatus {
    #[serde(rename = "checking")]
    Checking,
    #[serde(rename = "not-available")]
    NotAvailable,
    #[serde(rename = "available", rename_all = "camelCase")]
    Available { version: String },
    #[serde(rename = "downloading", rename_all = "camelCase")]
    Downloading {
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<u32>,
    },
    #[serde(rename = "downloaded", rename_all = "camelCase")]
    Downloaded { version: String },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error { message: String },
    #[serde(rename = "not-packaged")]
    NotPackaged,
}

/// Updates need a packaged build: a development build has no installer to
/// replace, and a smoke-test instance must not install over the real one.
pub fn updates_enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var_os("FTPEACH_SMOKE_TEST").is_none()
}

fn send(app: &AppHandle, status: UpdaterStatus) {
    if let Ok(mut last) = app.state::<UpdaterState>().status.lock() {
        *last = Some(status.clone());
    }
    let _ = app.emit("updater:status", status);
}

pub fn report_unavailable(app: &AppHandle) {
    send(app, UpdaterStatus::NotPackaged);
}

/// Clears `busy` again however its holder leaves.
struct Busy<'a>(&'a AtomicBool);

impl<'a> Busy<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        (!flag.swap(true, Ordering::SeqCst)).then_some(Self(flag))
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn staging_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_local_data_dir()?.join("updates"))
}

fn release_pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_owned)
}

/// The "Update automatically" setting: check at startup and once a day, and
/// download whatever is found without waiting for a click.
async fn auto_update_enabled(app: &AppHandle) -> bool {
    app.state::<Store>()
        .get_settings()
        .await
        .get("autoCheckUpdates")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

/// Runs the installer a previous session downloaded, before this session
/// shows anything. When it starts, this process ends here and the installer
/// launches the new version once it is done.
pub fn install_staged_at_startup(app: &AppHandle) {
    if !updates_enabled() {
        return;
    }
    let (Ok(dir), Some(pubkey)) = (staging_dir(app), release_pubkey(app)) else {
        return;
    };
    let Some(staged) = update_staging::ready_to_install(&dir, &app.package_info().version, &pubkey)
    else {
        return;
    };
    match update_staging::install(&dir, &staged) {
        // Nothing needs an orderly shutdown yet: there is no tray icon, no
        // visible window and no connection.
        Ok(()) => std::process::exit(0),
        Err(error) => log::warn!(
            "could not start the installer for {}: {error:#}",
            staged.version
        ),
    }
}

/// Starts the startup check without holding up the window.
pub fn check_at_startup(app: &AppHandle) {
    if !updates_enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if auto_update_enabled(&app).await {
            // The outcome reaches the status bar through `updater:status`;
            // a background check that fails is not worth an error of its own.
            let _ = check(&app).await;
        }
    });
}

pub async fn check(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<UpdaterState>();
    let Some(_busy) = Busy::acquire(&state.busy) else {
        return Ok(());
    };
    if let Some(version) = state.downloaded() {
        send(app, UpdaterStatus::Downloaded { version });
        return Ok(());
    }
    let version = match find_update(app, &state).await {
        Ok(Some(version)) => version,
        Ok(None) => {
            send(app, UpdaterStatus::NotAvailable);
            return Ok(());
        }
        Err(error) => {
            send(
                app,
                UpdaterStatus::Error {
                    message: error.to_string(),
                },
            );
            return Err(error);
        }
    };
    send(app, UpdaterStatus::Available { version });
    if auto_update_enabled(app).await {
        download_available(app, &state).await?;
    }
    Ok(())
}

async fn find_update(app: &AppHandle, state: &UpdaterState) -> anyhow::Result<Option<String>> {
    let mut available = state.available.lock().await;
    if available.is_none() {
        send(app, UpdaterStatus::Checking);
        *available = app.updater()?.check().await?;
    }
    Ok(available.as_ref().map(|update| update.version.clone()))
}

pub async fn download(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<UpdaterState>();
    let Some(_busy) = Busy::acquire(&state.busy) else {
        return Ok(());
    };
    download_available(app, &state).await
}

async fn download_available(app: &AppHandle, state: &UpdaterState) -> anyhow::Result<()> {
    let mut available = state.available.lock().await;
    let update = available
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No available update"))?;
    let version = update.version.clone();
    send(
        app,
        UpdaterStatus::Downloading {
            version: version.clone(),
            percent: None,
        },
    );
    match download_and_stage(app, update).await {
        Ok(staged) => {
            *available = None;
            state.set_downloaded(Some(staged.version));
            send(app, UpdaterStatus::Downloaded { version });
            Ok(())
        }
        Err(error) => {
            // Keep the offer, so a failed download can be retried from the
            // status bar.
            send(app, UpdaterStatus::Available { version });
            Err(error)
        }
    }
}

async fn download_and_stage(app: &AppHandle, update: &Update) -> anyhow::Result<StagedUpdate> {
    let mut received = 0u64;
    let mut last_percent = None;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let Some(total) = total.filter(|&total| total > 0) else {
                    return;
                };
                let percent = ((received as f64 / total as f64) * 100.0)
                    .round()
                    .min(100.0) as u32;
                if last_percent != Some(percent) {
                    last_percent = Some(percent);
                    send(
                        app,
                        UpdaterStatus::Downloading {
                            version: update.version.clone(),
                            percent: Some(percent),
                        },
                    );
                }
            },
            || {},
        )
        .await?;
    let dir = staging_dir(app)?;
    let (version, signature) = (update.version.clone(), update.signature.clone());
    tokio::task::spawn_blocking(move || update_staging::stage(&dir, &version, &signature, &bytes))
        .await?
}

/// Installs the downloaded update straight away: the same silent install the
/// next launch would run, after the orderly shutdown closing the window does.
pub async fn install_now(app: &AppHandle) -> anyhow::Result<()> {
    let dir = staging_dir(app)?;
    let pubkey = release_pubkey(app)
        .ok_or_else(|| anyhow::anyhow!("Updater public key is not configured"))?;
    let current = app.package_info().version.clone();
    let lookup = dir.clone();
    let staged = tokio::task::spawn_blocking(move || {
        update_staging::ready_to_install(&lookup, &current, &pubkey)
    })
    .await?;
    let Some(staged) = staged else {
        // Whatever was staged failed its checks and is gone; stop offering it.
        state_after_lost_download(app);
        return Err(
            std::io::Error::new(std::io::ErrorKind::NotFound, "No downloaded update").into(),
        );
    };
    if !app.state::<ShutdownCoordinator>().begin() {
        // Already closing; the next launch installs it.
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("main") {
        shutdown::wind_down(app.clone(), window).await;
    }
    // Connections are closed and the vault is locked by now, so a failed
    // start has no session left to return to; the next launch discards it.
    if let Err(error) = update_staging::install(&dir, &staged) {
        log::warn!(
            "could not start the installer for {}: {error:#}",
            staged.version
        );
    }
    app.exit(0);
    Ok(())
}

fn state_after_lost_download(app: &AppHandle) {
    app.state::<UpdaterState>().set_downloaded(None);
    send(
        app,
        UpdaterStatus::Error {
            message: "The downloaded update could not be verified".into(),
        },
    );
}

#[cfg(test)]
mod serde_field_casing {
    use super::*;

    #[test]
    fn downloading_percent_is_camel_case_and_present() {
        let value = serde_json::to_value(UpdaterStatus::Downloading {
            version: "1.2.3".into(),
            percent: Some(50),
        })
        .unwrap();
        assert!(
            value.get("percent").is_some(),
            "expected percent, got {value}"
        );
        assert!(
            value.get("version").is_some(),
            "expected version, got {value}"
        );
        assert_eq!(
            value.get("state").and_then(|v| v.as_str()),
            Some("downloading")
        );
    }
}
