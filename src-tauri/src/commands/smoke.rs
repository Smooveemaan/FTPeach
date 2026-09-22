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
    // PageLoad reports both Started and Finished for the result navigation.
    if !app
        .state::<crate::runtime::shutdown::ShutdownCoordinator>()
        .begin()
    {
        return;
    }
    if result != "ok" {
        report_phase(result);
        app.exit(1);
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match verify_editor_shutdown(&app).await {
            Ok(()) => {
                report_phase("ok");
                app.exit(0);
            }
            Err(error) => {
                report_phase(&format!("error: editor shutdown recovery: {error}"));
                app.exit(1);
            }
        }
    });
}

/// Runs the same real Tauri cleanup used by quit and install_now, without
/// launching an installer or touching anything outside isolated smoke data.
async fn verify_editor_shutdown(app: &tauri::AppHandle) -> anyhow::Result<()> {
    use crate::local_fs::{edit_recovery, open_with::OpenWithWatchers, preview::PreviewPaths};
    let paths = app.state::<PreviewPaths>();
    let folder = paths.open_with_dir.join("shutdown-fixture");
    fs::create_dir_all(&folder)?;
    let file = folder.join("edited.txt");
    fs::write(&file, b"server copy")?;
    let watchers = app.state::<OpenWithWatchers>();
    watchers.register(
        "smoke-editor",
        fs::canonicalize(&file)?,
        "/edited.txt".into(),
    );
    fs::write(&file, b"edits before quit or update")?;
    anyhow::ensure!(watchers.unsynced_count() == 1, "edit not detected");
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow::anyhow!("no main window"))?;
    crate::runtime::shutdown::wind_down(app.clone(), window).await;
    anyhow::ensure!(
        app.state::<Vault>().status().await.locked,
        "shutdown did not lock vault"
    );
    let root = edit_recovery::root(app).ok_or_else(|| anyhow::anyhow!("no recovery root"))?;
    anyhow::ensure!(
        edit_recovery::list(&root).len() == 1,
        "shutdown lost the edited copy"
    );
    let mut found = false;
    for entry in fs::read_dir(root)? {
        let candidate = entry?.path().join("edited.txt");
        if candidate.is_file() {
            anyhow::ensure!(
                fs::read(candidate)? == b"edits before quit or update",
                "recovery changed the payload"
            );
            found = true;
        }
    }
    anyhow::ensure!(found, "recovery has no payload");
    Ok(())
}
