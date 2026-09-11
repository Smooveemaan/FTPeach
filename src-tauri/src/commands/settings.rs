use crate::domain::AppSettings;
use crate::ipc::CommandResult;
use crate::runtime::log_emitter::LogEmitter;
use crate::runtime::settings_apply::{
    apply_log_date_format, apply_prevent_sleep, apply_transfer_limits,
};
use crate::store::{JsonMap, Store};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn settings_get(store: State<'_, Store>) -> CommandResult<AppSettings> {
    let mut settings = strip_proxy_secret(store.get_settings().await);
    settings.insert(
        "storageWarnings".into(),
        serde_json::json!(store.storage_warnings()),
    );
    Ok(AppSettings(settings))
}

fn strip_proxy_secret(mut settings: JsonMap) -> JsonMap {
    // Remove both representations unconditionally. Using a short-circuiting
    // `||` here would leave the legacy plaintext field in the IPC response
    // whenever the encrypted field was also present.
    let has_encrypted_secret = settings
        .remove("proxyPasswordEnc")
        .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
    let has_plaintext_secret = settings
        .remove("proxyPasswordPlain")
        .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
    let has_secret = has_encrypted_secret || has_plaintext_secret;
    settings.insert("proxyPasswordSet".into(), Value::Bool(has_secret));
    settings
}

#[tauri::command]
pub async fn settings_reveal_proxy_password(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    store: State<'_, Store>,
) -> CommandResult<Option<String>> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "settings_reveal_proxy_password",
        "proxy",
    )?;
    Ok(store.reveal_proxy_password().await?)
}

#[tauri::command]
pub async fn settings_set(
    store: State<'_, Store>,
    log_emitter: State<'_, LogEmitter>,
    patch: AppSettings,
) -> CommandResult<AppSettings> {
    let patch = patch.0;
    let had_speed_limit = patch.contains_key("transferSpeedLimitKBps");
    let had_prevent_sleep = patch.contains_key("preventSleepDuringTransfers");
    let had_date_format = patch.contains_key("dateFormat");
    let next = store.set_settings(patch).await?;
    if had_speed_limit {
        apply_transfer_limits(&next);
    }
    if had_prevent_sleep {
        apply_prevent_sleep(&next);
    }
    if had_date_format {
        apply_log_date_format(&next, &log_emitter);
    }
    Ok(AppSettings(strip_proxy_secret(next)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_settings_ipc_exposes_only_proxy_password_presence() {
        let settings = serde_json::from_value::<JsonMap>(serde_json::json!({
            "proxyEnabled": true,
            "proxyPasswordEnc": "encrypted-secret",
            "proxyPasswordPlain": "legacy-secret"
        }))
        .unwrap();

        let clean = strip_proxy_secret(settings);
        let serialized = serde_json::to_string(&clean).unwrap();

        assert_eq!(clean.get("proxyPasswordSet"), Some(&Value::Bool(true)));
        assert!(!serialized.contains("encrypted-secret"));
        assert!(!serialized.contains("legacy-secret"));
        assert!(!serialized.contains("proxyPasswordEnc"));
        assert!(!serialized.contains("proxyPasswordPlain"));
    }
}
