use crate::domain::{SavedSite, SiteLayoutEntry};
use crate::ipc::{CommandError, CommandResult};
use crate::security::vault::Vault;
use crate::store::{JsonMap, Store};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum SiteOpResult {
    Saved {
        ok: bool,
        id: String,
        #[serde(rename = "secretNotPersisted")]
        secret_not_persisted: bool,
    },
    Ok {
        ok: bool,
    },
    Err {
        ok: bool,
        error: CommandError,
    },
}

#[tauri::command]
pub async fn sites_list(store: State<'_, Store>) -> CommandResult<SiteList> {
    let sites = store
        .list_sites()
        .await?
        .into_iter()
        .map(SavedSite)
        .collect();
    Ok(SiteList {
        sites,
        warnings: store.storage_warnings(),
    })
}

#[derive(Serialize)]
pub struct SiteList {
    sites: Vec<SavedSite>,
    warnings: Vec<String>,
}

#[tauri::command]
pub async fn sites_has_legacy_secret(store: State<'_, Store>) -> CommandResult<bool> {
    Ok(store.has_undecryptable_secret().await)
}

#[tauri::command]
pub async fn sites_has_plaintext_secret(store: State<'_, Store>) -> CommandResult<bool> {
    Ok(store.has_plaintext_secret().await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecretResult {
    ok: bool,
    value: Option<String>,
    error: Option<CommandError>,
}

#[tauri::command]
pub async fn sites_reveal_secret(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    id: String,
    field: String,
) -> CommandResult<RevealedSecretResult> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "sites_reveal_secret",
        &format!("{id}:{field}"),
    )?;
    let result = if vault.is_configured() {
        vault.get_secret(&id, &field).await.map(|value| {
            value
                .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
                .filter(|value| !value.is_empty())
        })
    } else {
        store.reveal_dpapi_secret(&id, &field).await
    };
    Ok(match result {
        Ok(value) => RevealedSecretResult {
            ok: true,
            value,
            error: None,
        },
        Err(error) => RevealedSecretResult {
            ok: false,
            value: None,
            error: Some(CommandError::from_anyhow(&error)),
        },
    })
}

#[tauri::command]
/// Saving a bookmark goes through the `sensitive` plugin: a saved password
/// kept while the server, port, account or TLS policy changes is moved only
/// with a grant the user confirmed for exactly that move. The grant is
/// checked against the bookmark as sent here, where only a string is a new
/// password, not against the request's `password: true`.
pub async fn sites_save(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    site: SavedSite,
) -> CommandResult<SiteOpResult> {
    let transfer = crate::security::sensitive::site_save_transfer_for(&store, &site.0).await;
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "sites_save",
        &crate::security::credential_scope::site_save_target(&site.0, transfer.as_ref()),
    )?;
    // The store checks the move again under its write lock, against the
    // bookmark and the password as they are when the save lands.
    Ok(
        match store
            .save_site_with_vault(site.0, transfer.as_ref(), &vault)
            .await
        {
            Ok(saved) => SiteOpResult::Saved {
                ok: true,
                id: saved.id,
                secret_not_persisted: saved.secret_not_persisted,
            },
            Err(e) => SiteOpResult::Err {
                ok: false,
                error: CommandError::from_anyhow(&e),
            },
        },
    )
}

#[tauri::command]
pub async fn sites_delete(
    store: State<'_, Store>,
    vault: State<'_, Vault>,
    id: String,
) -> CommandResult<SiteOpResult> {
    Ok(match store.delete_site_with_vault(id, &vault).await {
        Ok(()) => SiteOpResult::Ok { ok: true },
        Err(e) => SiteOpResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&e),
        },
    })
}

#[tauri::command]
pub async fn sites_save_folder(
    store: State<'_, Store>,
    folder: JsonMap,
) -> CommandResult<SiteOpResult> {
    Ok(match store.save_folder(folder).await {
        Ok(id) => SiteOpResult::Saved {
            ok: true,
            id,
            secret_not_persisted: false,
        },
        Err(e) => SiteOpResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&e),
        },
    })
}

#[tauri::command]
pub async fn sites_delete_folder(
    store: State<'_, Store>,
    id: String,
) -> CommandResult<SiteOpResult> {
    Ok(match store.delete_folder(&id).await {
        Ok(()) => SiteOpResult::Ok { ok: true },
        Err(e) => SiteOpResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&e),
        },
    })
}

#[tauri::command]
pub async fn sites_apply_layout(
    store: State<'_, Store>,
    layout: Vec<SiteLayoutEntry>,
) -> CommandResult<SiteOpResult> {
    Ok(match store.apply_layout(layout).await {
        Ok(()) => SiteOpResult::Ok { ok: true },
        Err(e) => SiteOpResult::Err {
            ok: false,
            error: CommandError::from_anyhow(&e),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_result_reports_secret_persistence_in_camel_case() {
        let value = serde_json::to_value(SiteOpResult::Saved {
            ok: true,
            id: "site-1".into(),
            secret_not_persisted: true,
        })
        .unwrap();

        assert_eq!(value["secretNotPersisted"], true);
        assert!(value.get("secret_not_persisted").is_none());
    }
}
