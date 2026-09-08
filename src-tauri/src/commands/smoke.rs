use crate::{security::vault::Vault, store::Store};
use serde_json::{Map, Value};
use std::fs;
use tauri::{Manager, State};

#[tauri::command]
pub async fn smoke_backend_checks(
    store: State<'_, Store>,
    vault: State<'_, Vault>,
) -> Result<String, String> {
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_none() {
        return Err("smoke checks are disabled".into());
    }

    let mut patch = Map::new();
    patch.insert("dateFormat".into(), Value::String("yyyy-MM-dd".into()));
    store
        .set_settings(patch)
        .await
        .map_err(|error| error.to_string())?;
    let settings = store.get_settings().await;
    if settings.get("dateFormat") != Some(&Value::String("yyyy-MM-dd".into())) {
        return Err("settings did not survive a store round trip".into());
    }

    const PASSWORD: &str = "packaged-smoke-password";
    vault
        .setup(PASSWORD)
        .await
        .map_err(|error| error.to_string())?;
    vault.lock().await;
    if !vault.status().await.locked {
        return Err("vault did not lock".into());
    }
    vault
        .unlock(PASSWORD)
        .await
        .map_err(|error| error.to_string())?;
    if vault.status().await.locked {
        return Err("vault did not unlock".into());
    }

    let source = store.data_dir().join("smoke-transfer-source.txt");
    let destination = store.data_dir().join("smoke-transfer-destination.txt");
    tokio::fs::write(&source, b"ftpeach-packaged-smoke")
        .await
        .map_err(|error| error.to_string())?;
    tokio::fs::copy(&source, &destination)
        .await
        .map_err(|error| error.to_string())?;
    let copied = tokio::fs::read(&destination)
        .await
        .map_err(|error| error.to_string())?;
    if copied != b"ftpeach-packaged-smoke" {
        return Err("basic file transfer changed the payload".into());
    }

    Ok("settings-vault-transfer-ok".into())
}

pub fn report_phase(phase: &str) {
    if let Some(path) = std::env::var_os("FTPEACH_SMOKE_RESULT") {
        let _ = fs::write(path, phase);
    }
}

pub fn finish(app: &tauri::AppHandle, result: &str) {
    if result != "ok" {
        report_phase(result);
        app.exit(1);
        return;
    }

    report_phase("ok");
    if let Some(window) = app.get_webview_window("main")
        && window.close().is_ok()
    {
        return;
    }
    report_phase("error: failed to request normal application close");
    app.exit(1);
}
