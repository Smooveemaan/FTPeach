use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::protocol::transport;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestRequest {
    pub proxy_type: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_username: Option<String>,
    #[serde(default)]
    pub proxy_password: Option<String>,
    pub target_host: String,
    pub target_port: u16,
}

/// Tests proxy settings against a real target. Deliberately takes the
/// proxy config as plain arguments — the SettingsDialog form's current
/// values — rather than reading settings.json, so the user can verify a
/// proxy *before* saving it. `target_host`/`target_port` are required: a
/// proxy accepting our TCP connection to itself says nothing about whether
/// its SOCKS/HTTP CONNECT handshake can actually reach a real server
/// through it — that's the thing worth testing. Any failure (bad input,
/// unreachable proxy, rejected handshake) surfaces the same way every
/// other command's failure does — a rejected promise the shared
/// `invoke()` wrapper (tauriApi.js) turns into `{ok:false, error, ...}` —
/// no bespoke result shape needed here.
#[tauri::command]
pub async fn proxy_test(request: ProxyTestRequest) -> CommandResult<()> {
    if request.target_host.trim().is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Target host is required to test a proxy",
        ));
    }
    if request.proxy_host.trim().is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Proxy host is required",
        ));
    }
    let config = json!({
        "proxyEnabled": true,
        "proxyType": request.proxy_type,
        "proxyHost": request.proxy_host,
        "proxyPort": request.proxy_port,
        "proxyUsername": request.proxy_username,
        "proxyPassword": request.proxy_password,
    });
    let proxy = transport::ProxyConfig::from_json_map(config.as_object().unwrap())?;
    transport::connect(&request.target_host, request.target_port, proxy.as_ref())
        .await
        .map(|_stream| ())
        .map_err(|err| CommandError::from_anyhow(&err))
}
