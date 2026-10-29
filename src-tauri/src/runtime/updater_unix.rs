//! Unix installation uses a fresh server offer and the plugin's native installer.

use super::*;

const OFFER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

async fn staged(app: &AppHandle) -> anyhow::Result<Option<StagedUpdate>> {
    let dir = staging_dir(app)?;
    let pubkey = release_pubkey(app)
        .ok_or_else(|| anyhow::anyhow!("Updater public key is not configured"))?;
    let current = app.package_info().version.clone();
    tokio::task::spawn_blocking(move || {
        update_staging::ready_to_install(&dir, &current, &pubkey, package())
    })
    .await
    .map_err(Into::into)
}

async fn fresh_offer<R: tauri::Runtime>(
    app: &AppHandle<R>,
    dir: &Path,
) -> anyhow::Result<Option<Update>> {
    // No cached offer: a removed release must not authorize a saved package.
    let updater = app.updater_builder().timeout(OFFER_DEADLINE).build()?;
    let response = tokio::time::timeout(OFFER_DEADLINE, updater.check())
        .await
        .map_err(|_| anyhow::anyhow!("The update check took too long"))?;
    let offer = match response {
        Err(error) if missing_target(&error) => None,
        result => result?,
    };
    if let Some(update) = offer.as_ref()
        && update_staging::matches_offer(dir, &update.version, &update.signature)?
    {
        return Ok(offer);
    }
    // A successful response withdrew or replaced the offer. A network error
    // above leaves the download and its retry state untouched.
    update_staging::discard(dir);
    let state = app.state::<UpdaterState>();
    state.set_downloaded(None);
    send(
        app,
        match offer.as_ref() {
            Some(update) => UpdaterStatus::Available {
                version: update.version.clone(),
            },
            None => UpdaterStatus::NotAvailable,
        },
    );
    *state.available.lock().await = offer;
    Ok(None)
}

pub(super) async fn resume_at_startup(app: &AppHandle) -> anyhow::Result<bool> {
    let state = app.state::<UpdaterState>();
    let Some(_busy) = Busy::acquire(&state.busy) else {
        return Ok(true);
    };
    let Some(staged) = staged(app).await? else {
        return Ok(false);
    };
    state.set_downloaded(Some(staged.version.clone()));
    send(
        app,
        UpdaterStatus::Downloaded {
            version: staged.version.clone(),
        },
    );
    if failed_before(app, &staged.version) {
        return Ok(true);
    }
    let dir = staging_dir(app)?;
    let Some(update) = fresh_offer(app, &dir).await? else {
        return Ok(false);
    };
    // The window stays responsive during the request. If work started in the
    // meantime, leave installation to the user or the next launch.
    if app.state::<crate::session::Sessions>().slot_count() == 0
        && shutdown::quit_route(
            super::super::tray::active_transfers(app),
            app.state::<crate::local_fs::open_with::OpenWithWatchers>()
                .unsynced_count(),
        ) == shutdown::QuitRoute::Now
    {
        apply(app, dir, update).await?;
    }
    Ok(true)
}

pub(super) async fn install_now(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<UpdaterState>();
    let Some(_busy) = Busy::acquire(&state.busy) else {
        return Ok(());
    };
    if staged(app).await?.is_none() {
        state_after_lost_download(app);
        anyhow::bail!("No downloaded update");
    }
    let dir = staging_dir(app)?;
    let update = fresh_offer(app, &dir)
        .await?
        .ok_or_else(|| anyhow::anyhow!("The server no longer offers the downloaded update"))?;
    apply(app, dir, update).await
}

async fn apply(app: &AppHandle, dir: PathBuf, update: Update) -> anyhow::Result<()> {
    let pubkey = release_pubkey(app)
        .ok_or_else(|| anyhow::anyhow!("Updater public key is not configured"))?;
    let current = app.package_info().version.clone();
    if !app.state::<ShutdownCoordinator>().begin() {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("main") {
        shutdown::wind_down(app.clone(), window).await;
    }
    let failed_dir = dir.clone();
    let version = semver::Version::parse(&update.version)?;
    let result = tokio::task::spawn_blocking(move || {
        update_staging::install_unix(
            &dir,
            &current,
            &pubkey,
            package(),
            (&update.version, &update.signature),
            &|bytes| update.install(bytes).map_err(Into::into),
        )
    })
    .await;
    if !matches!(result, Ok(Ok(_))) {
        log::warn!("could not install the staged update: {result:?}");
        if !update_staging::remember_failed(&failed_dir, &version) {
            // Do not restart into the same failure if its record cannot be saved.
            app.exit(0);
            return Ok(());
        }
    }
    // A failed installation reopens the old app; the attempted mark prevents
    // an installation loop, and the sessions have already been closed.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
#[path = "updater_unix_tests.rs"]
mod tests;
