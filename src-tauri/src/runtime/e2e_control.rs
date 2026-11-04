//! Authenticated loopback evaluation for desktop tests on every webview engine.
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const LIMIT: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    window: String,
    script: String,
}

fn request(line: &[u8], token: &str) -> Result<Request, String> {
    if line.len() > LIMIT || !line.ends_with(b"\n") {
        return Err("control request exceeds limit or has no newline".into());
    }
    let request: Request = serde_json::from_slice(line).map_err(|error| error.to_string())?;
    if request.token != token {
        return Err("invalid control token".into());
    }
    Ok(request)
}

pub(crate) fn start(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Ok(port) = std::env::var("FTPEACH_E2E_CONTROL_PORT") else {
        return Ok(());
    };
    let port: u16 = port.parse()?;
    let token = std::env::var("FTPEACH_E2E_CONTROL_TOKEN")?;
    if token.len() < 32 || port == 0 {
        return Err("control requires a nonzero port and a token of at least 32 bytes".into());
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?;
    listener.set_nonblocking(true)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                log::error!("desktop control listener: {error}");
                return;
            }
        };
        let clients = Arc::new(tokio::sync::Semaphore::new(8));
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = clients.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            let token = token.clone();
            // A pending action may need another request to answer its confirmation window.
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                if let Err(error) = tokio::time::timeout(TIMEOUT, serve(&app, stream, &token)).await
                {
                    log::warn!("desktop control request: {error}");
                }
            });
        }
    });
    Ok(())
}

async fn serve(app: &tauri::AppHandle, stream: tokio::net::TcpStream, token: &str) {
    use tokio::io::AsyncReadExt;
    let (reader, mut writer) = stream.into_split();
    let mut line = Vec::new();
    let result = match BufReader::new(reader)
        .take((LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)
        .await
    {
        Ok(_) => match request(&line, token) {
            Ok(request) => evaluate(app, request).await,
            Err(error) => Err(error),
        },
        Err(error) => Err(error.to_string()),
    };
    let response = match result {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error }),
    };
    let mut response = response.to_string();
    if response.len() > LIMIT {
        response = json!({"error": "control response exceeds limit"}).to_string();
    }
    response.push('\n');
    let _ = writer.write_all(response.as_bytes()).await;
}

async fn evaluate(app: &tauri::AppHandle, request: Request) -> Result<Value, String> {
    if request.window == "*" {
        return Ok(json!(app.webview_windows().keys().collect::<Vec<_>>()));
    }
    let window = app
        .get_webview_window(&request.window)
        .ok_or("window not found")?;
    let url = window.url().map_err(|error| error.to_string())?;
    if !(url.scheme() == "tauri"
        || matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        ))
    {
        return Err("control only evaluates application pages".into());
    }
    let key =
        serde_json::to_string(&format!("__ftpeach_control_{}", uuid::Uuid::new_v4())).unwrap();
    window.eval(format!(
        "(() => {{ const slot = window[{key}] = {{done:false}}; Promise.resolve().then(() => ({})).then(value => {{slot.result={{value:value ?? null}};slot.done=true;}}, error => {{slot.result={{error:String(error) + (error?.stack ? \"\\n\" + error.stack : \"\")}};slot.done=true;}}); }})()",
        request.script
    )).map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            window
                .eval_with_callback(
                    format!("window[{key}]?.done ? window[{key}].result : null"),
                    move |value| {
                        let _ = sender.send(value);
                    },
                )
                .map_err(|error| error.to_string())?;
            let value = receiver.recv().await.ok_or("evaluation callback closed")?;
            let value: Value = serde_json::from_str(&value).map_err(|error| error.to_string())?;
            if !value.is_null() {
                return if let Some(error) = value.get("error") {
                    Err(error.as_str().unwrap_or("evaluation failed").to_owned())
                } else {
                    Ok(value["value"].clone())
                };
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "control evaluation timed out".to_owned())
    .and_then(|value| value);
    let _ = window.eval(format!("delete window[{key}]"));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_authenticated_bounded_complete_requests() {
        let line = b"{\"token\":\"secret\",\"window\":\"main\",\"script\":\"1+1\"}\n";
        assert_eq!(request(line, "secret").unwrap().script, "1+1");
        assert!(request(line, "different").is_err());
        assert!(request(&line[..line.len() - 1], "secret").is_err());
        assert!(request(&vec![b' '; LIMIT + 1], "secret").is_err());
        assert!(request(b"{}\n", "secret").is_err());
    }
}
