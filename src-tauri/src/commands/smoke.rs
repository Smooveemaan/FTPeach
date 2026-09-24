use crate::{security::vault::Vault, store::Store};
use serde_json::{Map, Value};
use std::fs;
use std::sync::Mutex;
use std::time::{Duration, Instant};
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

/// What the confirmation window reported about the commands it can reach.
static ACL_PROBE: Mutex<Option<String>> = Mutex::new(None);

/// The confirmation window has no command it is allowed to answer with, so it
/// navigates to a URL carrying its verdict and `on_page_load` lands here.
pub fn record_acl_probe(result: &str) {
    if let Ok(mut slot) = ACL_PROBE.lock() {
        *slot = Some(result.to_owned());
    }
}

/// Asks a live confirmation window which application commands it can still
/// call. The window class is the point of the test: its capability file grants
/// it only the three confirmation commands, so everything else has to be
/// rejected by the ACL before it reaches any backend code.
#[tauri::command]
pub async fn smoke_probe_confirmation_acl(app: tauri::AppHandle) -> Result<String, String> {
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_none() {
        return Err("smoke checks are disabled".into());
    }
    if let Ok(mut slot) = ACL_PROBE.lock() {
        *slot = None;
    }
    let window = wait_for(Duration::from_secs(10), || {
        app.webview_windows()
            .into_iter()
            .find(|(label, _)| label.starts_with("security-confirmation-"))
            .map(|(_, window)| window)
    })
    .await
    .ok_or("no confirmation window opened")?;
    // The window can already exist while its document is still loading, and a
    // script evaluated into a document that is about to be replaced is lost.
    // The probe is written to be re-entrant so it can simply be offered again.
    let verdict = wait_for(Duration::from_secs(20), || {
        let _ = window.eval(include_str!("../../assets/acl_probe.js"));
        ACL_PROBE.lock().ok().and_then(|slot| slot.clone())
    })
    .await;
    let _ = window.close();
    verdict.ok_or_else(|| "confirmation window never reported its ACL probe".to_string())
}

async fn wait_for<T>(timeout: Duration, mut attempt: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = attempt() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub fn report_phase(phase: &str) {
    if let Some(path) = std::env::var_os("FTPEACH_SMOKE_RESULT") {
        let _ = fs::write(path, phase);
    }
}

pub fn finish(app: &tauri::AppHandle, result: &str) {
    finish_with_expected(app, result, None);
}

/// Keeps the renderer alive while the real shutdown handshake drains its writes.
#[tauri::command]
pub fn smoke_finish(
    app: tauri::AppHandle,
    result: String,
    expected_tabs: usize,
    expected_orientation: String,
) {
    if std::env::var_os("FTPEACH_SMOKE_TEST").is_some() {
        finish_with_expected(&app, &result, Some((expected_tabs, expected_orientation)));
    }
}

fn finish_with_expected(app: &tauri::AppHandle, result: &str, expected: Option<(usize, String)>) {
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
        match verify_editor_shutdown(&app, expected).await {
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
async fn verify_editor_shutdown(
    app: &tauri::AppHandle,
    expected: Option<(usize, String)>,
) -> anyhow::Result<()> {
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
    let state_saved = crate::runtime::shutdown::wind_down(app.clone(), window).await;
    if let Some((tabs, orientation)) = expected {
        anyhow::ensure!(
            state_saved,
            "renderer did not acknowledge a successful shutdown flush"
        );
        // Read files afresh, as the next process will; no cached Store state.
        let store = app.state::<Store>();
        let saved_tabs: Value =
            serde_json::from_slice(&fs::read(store.data_dir().join("tabs.json"))?)?;
        let saved_settings: Value =
            serde_json::from_slice(&fs::read(store.data_dir().join("settings.json"))?)?;
        anyhow::ensure!(
            saved_tabs["data"]["tabs"].as_array().map(Vec::len) == Some(tabs),
            "shutdown lost the last tab"
        );
        anyhow::ensure!(
            saved_settings["data"]["paneOrientation"].as_str() == Some(orientation.as_str()),
            "shutdown lost the last setting"
        );
    }
    anyhow::ensure!(
        app.state::<Vault>().status().await.locked,
        "shutdown did not lock vault"
    );
    let root = edit_recovery::root(app).ok_or_else(|| anyhow::anyhow!("no recovery root"))?;
    let recovered = edit_recovery::entries(&root);
    anyhow::ensure!(recovered.len() == 1, "shutdown lost the edited copy");
    anyhow::ensure!(
        recovered[0].edit.name == "edited.txt"
            && fs::read(&recovered[0].file)? == b"edits before quit or update",
        "recovery changed the payload"
    );
    Ok(())
}
