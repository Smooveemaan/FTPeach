use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::protocol::transport;
use crate::security::sensitive_string::SensitiveString;
use serde::Deserialize;
use std::time::Duration;

/// One test at a time, and no longer than this.
///
/// A TCP connect and a proxy handshake each have their own operating-system
/// timeout, which together say nothing about how long the command may run.
/// A proxy that accepts the connection and then never answers held a task
/// indefinitely, once per press of the button.
const PROXY_TEST_DEADLINE: Duration = Duration::from_secs(20);
static PROXY_TESTS: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(1));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestRequest {
    pub proxy_type: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_username: Option<String>,
    #[serde(default)]
    pub proxy_password: Option<SensitiveString>,
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
    let proxy = transport::ProxyConfig::new(
        Some(&request.proxy_type),
        &request.proxy_host,
        request.proxy_port,
        request.proxy_username.as_deref(),
        request.proxy_password,
    )?;
    let _permit = PROXY_TESTS.try_acquire().map_err(|_| {
        CommandError::new(ErrorCode::ResourceLimit, "A proxy test is already running")
    })?;
    let attempt = transport::connect(&request.target_host, request.target_port, Some(&proxy));
    match tokio::time::timeout(PROXY_TEST_DEADLINE, attempt).await {
        Ok(result) => result
            .map(|_stream| ())
            .map_err(|err| CommandError::from_anyhow(&err)),
        Err(_) => Err(CommandError::new(
            ErrorCode::TimedOut,
            "The proxy did not finish the connection in time",
        )),
    }
}
