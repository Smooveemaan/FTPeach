use crate::ipc::{CommandError, CommandResult};
use crate::security::vault::{Vault, VaultStatus};
use crate::security::vault_guard::VaultGuard;
use crate::store::Store;
use serde::Serialize;
use tauri::State;
use zeroize::Zeroize;

#[cfg(windows)]
fn window_handle(window: &tauri::WebviewWindow) -> anyhow::Result<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle()?.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get()),
        _ => anyhow::bail!("system unlock requires a Windows application window"),
    }
}

#[cfg(not(windows))]
fn window_handle(_: &tauri::WebviewWindow) -> anyhow::Result<isize> {
    Ok(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultResult {
    ok: bool,
    error: Option<CommandError>,
}

impl VaultResult {
    fn from_result(result: anyhow::Result<()>) -> Self {
        match result {
            Ok(()) => Self {
                ok: true,
                error: None,
            },
            Err(error) => Self {
                ok: false,
                error: Some(CommandError::from_anyhow(&error)),
            },
        }
    }

    fn from_guarded_result(result: anyhow::Result<()>) -> Self {
        match result {
            Ok(()) => Self {
                ok: true,
                error: None,
            },
            Err(_) => Self {
                ok: false,
                error: Some(CommandError::from_anyhow(&anyhow::anyhow!(
                    "Vault authentication failed or temporarily unavailable"
                ))),
            },
        }
    }
}

#[tauri::command]
pub async fn vault_status(vault: State<'_, Vault>) -> CommandResult<VaultStatus> {
    Ok(vault.status().await)
}

#[tauri::command]
pub async fn vault_setup(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    mut master_password: String,
) -> CommandResult<VaultResult> {
    let result = async {
        let _permit = guard.acquire().await?;
        vault.setup(&master_password).await?;
        store.migrate_secrets_to_vault(&vault).await?;
        Ok(())
    }
    .await;
    master_password.zeroize();
    Ok(VaultResult::from_guarded_result(result))
}

#[tauri::command]
pub async fn vault_unlock(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    mut master_password: String,
) -> CommandResult<VaultResult> {
    let started = std::time::Instant::now();
    let result = async {
        let _permit = guard.acquire().await?;
        vault.unlock(&master_password).await?;
        let vault_unlocked = started.elapsed();
        store.migrate_secrets_to_vault(&vault).await?;
        // Debug-only — see vault.rs's identical `if cfg!(...)` for why this
        // isn't a `#[cfg(debug_assertions)]` on the statement instead.
        if cfg!(debug_assertions) {
            eprintln!(
                "FTPeach vault command timings: unlock={}ms, migration={}ms, total={}ms",
                vault_unlocked.as_millis(),
                started.elapsed().saturating_sub(vault_unlocked).as_millis(),
                started.elapsed().as_millis(),
            );
        }
        Ok(())
    }
    .await;
    if result.is_ok() {
        guard.succeeded().await;
    } else {
        guard.failed().await;
    }
    master_password.zeroize();
    Ok(VaultResult::from_guarded_result(result))
}

#[tauri::command]
pub async fn vault_lock(vault: State<'_, Vault>) -> CommandResult<VaultResult> {
    vault.lock().await;
    Ok(VaultResult {
        ok: true,
        error: None,
    })
}

#[tauri::command]
pub async fn vault_enable_system_unlock(
    vault: State<'_, Vault>,
    window: tauri::WebviewWindow,
) -> CommandResult<VaultResult> {
    let result = match window_handle(&window) {
        Ok(hwnd) => vault.enable_system_unlock(hwnd).await,
        Err(error) => Err(error),
    };
    Ok(VaultResult::from_result(result))
}

#[tauri::command]
pub async fn vault_unlock_system(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    window: tauri::WebviewWindow,
) -> CommandResult<VaultResult> {
    let result = async {
        let _permit = guard.acquire().await?;
        vault.unlock_system(window_handle(&window)?).await?;
        store.migrate_secrets_to_vault(&vault).await?;
        Ok(())
    }
    .await;
    if result.is_ok() {
        guard.succeeded().await;
    } else {
        guard.failed().await;
    }
    Ok(VaultResult::from_guarded_result(result))
}

#[tauri::command]
pub async fn vault_disable_system_unlock(vault: State<'_, Vault>) -> CommandResult<VaultResult> {
    Ok(VaultResult::from_result(
        vault.disable_system_unlock().await,
    ))
}

#[tauri::command]
pub async fn vault_change_password(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    mut old_password: String,
    mut new_password: String,
) -> CommandResult<VaultResult> {
    let result = async {
        let _permit = guard.acquire().await?;
        vault.change_password(&old_password, &new_password).await
    }
    .await;
    if result.is_ok() {
        guard.succeeded().await;
    } else {
        guard.failed().await;
    }
    old_password.zeroize();
    new_password.zeroize();
    Ok(VaultResult::from_guarded_result(result))
}

#[tauri::command]
pub async fn vault_reset(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
) -> CommandResult<VaultResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "vault_reset",
        "vault",
    )?;
    let result = async {
        let _permit = guard.acquire().await?;
        vault.reset().await?;
        store.clear_vault_secret_flags().await?;
        Ok(())
    }
    .await;
    if result.is_ok() {
        guard.succeeded().await;
    }
    Ok(VaultResult::from_result(result))
}

#[tauri::command]
pub async fn vault_use_system_protection(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    mut master_password: String,
) -> CommandResult<VaultResult> {
    let result = async {
        let _permit = guard.acquire().await?;
        if !vault.is_unlocked().await && !master_password.is_empty() {
            vault.unlock(&master_password).await?;
        }
        if !vault.is_unlocked().await {
            anyhow::bail!("vault is locked");
        }
        store.migrate_secrets_from_vault(&vault).await?;
        vault.remove_unlocked().await?;
        store.clear_vault_secret_flags().await?;
        Ok(())
    }
    .await;
    if result.is_ok() {
        guard.succeeded().await;
    } else {
        guard.failed().await;
    }
    master_password.zeroize();
    Ok(VaultResult::from_guarded_result(result))
}
