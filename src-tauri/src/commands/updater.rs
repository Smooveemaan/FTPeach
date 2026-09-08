use crate::ipc::{CommandError, CommandResult, ErrorCode};
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Default)]
pub struct UpdaterState {
    checking: AtomicBool,
    available: AsyncMutex<Option<Update>>,
    downloaded: AsyncMutex<Option<(Update, Vec<u8>)>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "state")]
enum UpdaterStatus {
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

fn send(app: &AppHandle, status: UpdaterStatus) {
    let _ = app.emit("updater:status", status);
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum CheckResult {
    Ok { ok: bool },
    Err { ok: bool, error: CommandError },
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> CommandResult<CheckResult> {
    if cfg!(debug_assertions) {
        send(&app, UpdaterStatus::NotPackaged);
        return Ok(CheckResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::Internal, "Updater unavailable in development"),
        });
    }
    if state.checking.swap(true, Ordering::SeqCst) {
        return Ok(CheckResult::Ok { ok: true });
    }

    send(&app, UpdaterStatus::Checking);
    let result = run_check(&app, &state).await;
    state.checking.store(false, Ordering::SeqCst);

    match result {
        Ok(()) => Ok(CheckResult::Ok { ok: true }),
        Err(err) => {
            send(
                &app,
                UpdaterStatus::Error {
                    message: err.to_string(),
                },
            );
            Ok(CheckResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&err),
            })
        }
    }
}

async fn run_check(app: &AppHandle, state: &State<'_, UpdaterState>) -> anyhow::Result<()> {
    if let Some((update, _)) = state.downloaded.lock().await.as_ref() {
        send(
            app,
            UpdaterStatus::Downloaded {
                version: update.version.clone(),
            },
        );
        return Ok(());
    }
    if let Some(update) = state.available.lock().await.as_ref() {
        send(
            app,
            UpdaterStatus::Available {
                version: update.version.clone(),
            },
        );
        return Ok(());
    }
    let Some(update) = app.updater()?.check().await? else {
        send(app, UpdaterStatus::NotAvailable);
        return Ok(());
    };

    let version = update.version.clone();
    *state.available.lock().await = Some(update);
    send(app, UpdaterStatus::Available { version });
    Ok(())
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> CommandResult<CheckResult> {
    if state.checking.swap(true, Ordering::SeqCst) {
        return Ok(CheckResult::Ok { ok: true });
    }
    let result = run_download(&app, &state).await;
    state.checking.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => Ok(CheckResult::Ok { ok: true }),
        Err(err) => {
            // Keep the offer available so a failed download can be retried.
            if let Some(update) = state.available.lock().await.as_ref() {
                send(
                    &app,
                    UpdaterStatus::Available {
                        version: update.version.clone(),
                    },
                );
            }
            Ok(CheckResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&err),
            })
        }
    }
}

async fn run_download(app: &AppHandle, state: &State<'_, UpdaterState>) -> anyhow::Result<()> {
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

    let downloaded = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let app_for_progress = app.clone();
    let version_for_progress = version.clone();
    let bytes = update
        .download(
            move |chunk_len, content_length| {
                let total =
                    downloaded.fetch_add(chunk_len as u64, Ordering::SeqCst) + chunk_len as u64;
                if let Some(content_length) = content_length.filter(|&len| len > 0) {
                    let percent = ((total as f64 / content_length as f64) * 100.0).round() as u32;
                    send(
                        &app_for_progress,
                        UpdaterStatus::Downloading {
                            version: version_for_progress.clone(),
                            percent: Some(percent.min(100)),
                        },
                    );
                }
            },
            || {},
        )
        .await?;

    let update = available
        .take()
        .expect("available update is held during download");
    *state.downloaded.lock().await = Some((update, bytes));
    send(
        app,
        UpdaterStatus::Downloaded {
            version: version.clone(),
        },
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum InstallResult {
    Err { ok: bool, error: CommandError },
}

#[tauri::command]
pub async fn updater_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> CommandResult<InstallResult> {
    let Some((update, bytes)) = state.downloaded.lock().await.take() else {
        return Ok(InstallResult::Err {
            ok: false,
            error: CommandError::new(ErrorCode::NotFound, "No downloaded update"),
        });
    };
    if let Err(err) = update.install(bytes) {
        return Ok(InstallResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&anyhow::anyhow!(err.to_string())),
        });
    }
    app.restart();
}
