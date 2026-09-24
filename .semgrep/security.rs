#[tauri::command]
async fn read_export(name: String) -> std::io::Result<Vec<u8>> {
    let path = std::path::Path::new("exports").join(name);
    // ruleid: rust-ipc-path-traversal
    tokio::fs::read(path).await
}

#[tauri::command]
fn read_export_sync(name: String) -> std::io::Result<Vec<u8>> {
    let path = std::path::Path::new("exports").join(name);
    // ruleid: rust-ipc-path-traversal
    std::fs::read(path)
}

#[tauri::command]
fn read_fixed(_name: String) -> std::io::Result<Vec<u8>> {
    // ok: rust-ipc-path-traversal
    std::fs::read("exports/fixed.txt")
}

fn tls() {
    // ruleid: rust-disabled-tls-verification
    client.danger_accept_invalid_certs(true);
    // ok: rust-disabled-tls-verification
    client.danger_accept_invalid_certs(false);
}

#[tauri::command]
async fn write_content(content: String) {
    // ok: rust-ipc-path-traversal
    tokio::fs::write("exports/fixed.txt", content).await;
}

#[tauri::command]
async fn open_with(remote_path: String) {
    let intent = OpenWithIntent::resolve(&remote_path)?;
    let path = std::path::Path::new("open-with").join(&intent.local_name);
    // ok: rust-ipc-path-traversal
    tokio::fs::remove_file(path).await;
}

#[tauri::command]
async fn safe_name(name: String) {
    let path = std::path::Path::new("exports").join(safe_temp_name(&name));
    // ok: rust-ipc-path-traversal
    tokio::fs::remove_file(path).await;
}

// ruleid: rust-credential-debug
#[derive(Clone, Debug)]
pub struct LeakyConfig {
    pub host: String,
    pub password: String,
}

// ruleid: rust-credential-debug
#[derive(Debug)]
struct LeakyToken {
    reveal_token: Option<String>,
}

// ok: rust-credential-debug
#[derive(Clone, Debug)]
pub struct RedactedConfig {
    pub host: String,
    pub password: SensitiveString,
}

// ok: rust-credential-debug
#[derive(Clone)]
pub struct NoDebugConfig {
    pub password: String,
}

fn channels() {
    // ruleid: rust-unbounded-channel
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    // ruleid: rust-unbounded-channel
    let (release, wait) = std::sync::mpsc::channel();
    // ok: rust-unbounded-channel
    let (sender, receiver) = tokio::sync::mpsc::channel(16);
}

#[cfg(test)]
mod tests {
    fn fixture() {
        // ok: rust-unbounded-channel
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        // ok: rust-security-setting-outside-policy
        let patch = json!({ "showSecurityConfirmations": false });
    }
}

fn policy_bypass(settings: &mut JsonMap) {
    // ruleid: rust-security-setting-outside-policy
    settings.insert("showSecurityConfirmations".into(), false.into());
    // ruleid: rust-security-setting-outside-policy
    settings.insert("vaultAutoLockMinutes".into(), 0.into());
    // ruleid: rust-security-setting-outside-policy
    settings.insert("strictHostKeyCheck".into(), false.into());
    // ok: rust-security-setting-outside-policy
    settings.insert(security_policy::CONFIRMATIONS.into(), true.into());
}
