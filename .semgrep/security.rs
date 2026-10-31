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

#[tauri::command]
fn path_buf_input(path: PathBuf) {
    // ruleid: rust-ipc-path-traversal
    std::fs::read(path);
}

#[tauri::command]
fn safe_path_buf_input(path: PathBuf) {
    let name = safe_temp_name(path.to_str().unwrap());
    // ok: rust-ipc-path-traversal
    std::fs::read(name);
}

#[tauri::command]
fn optional_input(path: Option<String>) {
    // ruleid: rust-ipc-path-traversal
    std::fs::read(path.unwrap());
}

#[tauri::command]
fn safe_optional_input(path: Option<String>) {
    let name = safe_temp_name(&path.unwrap());
    // ok: rust-ipc-path-traversal
    std::fs::read(name);
}

#[tauri::command]
fn vector_input(paths: Vec<String>) {
    // ruleid: rust-ipc-path-traversal
    std::fs::read(&paths[0]);
}

#[tauri::command]
fn safe_vector_input(paths: Vec<String>) {
    let name = safe_temp_name(&paths[0]);
    // ok: rust-ipc-path-traversal
    std::fs::read(name);
}

#[tauri::command]
fn request_input(request: ReadRequest) {
    // ruleid: rust-ipc-path-traversal
    std::fs::read(request.path);
}

#[tauri::command]
fn safe_request_input(request: ReadRequest) {
    let name = safe_temp_name(&request.path);
    // ok: rust-ipc-path-traversal
    std::fs::read(name);
}

#[tauri::command]
fn trusted_context(
    imported_state: State<'_, Store>,
    qualified_state: tauri::State<'_, Store>,
    app: AppHandle,
    generic_app: tauri::AppHandle<R>,
    window: WebviewWindow,
    generic_window: tauri::WebviewWindow<R>,
    path: String,
) {
    // ok: rust-ipc-path-traversal
    std::fs::read(imported_state.path);
    // ok: rust-ipc-path-traversal
    std::fs::read(qualified_state.path);
    // ok: rust-ipc-path-traversal
    std::fs::read(app.path);
    // ok: rust-ipc-path-traversal
    std::fs::read(generic_app.path);
    // ok: rust-ipc-path-traversal
    std::fs::read(window.path);
    // ok: rust-ipc-path-traversal
    std::fs::read(generic_window.path);
    // ruleid: rust-ipc-path-traversal
    std::fs::read(path);
}

#[tauri::command]
fn std_filesystem_sinks(path: String) {
    // ruleid: rust-ipc-path-traversal
    std::fs::read_to_string(&path);
    // ok: rust-ipc-path-traversal
    std::fs::read_to_string("fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::write(&path, "content");
    // ok: rust-ipc-path-traversal
    std::fs::write("fixed.txt", "content");
    // ruleid: rust-ipc-path-traversal
    std::fs::remove_file(&path);
    // ok: rust-ipc-path-traversal
    std::fs::remove_file("fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::copy(&path, "fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::copy("fixed.txt", &path);
    // ok: rust-ipc-path-traversal
    std::fs::copy("fixed.txt", "other.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::rename(&path, "fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::rename("fixed.txt", &path);
    // ok: rust-ipc-path-traversal
    std::fs::rename("fixed.txt", "other.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::File::open(&path);
    // ok: rust-ipc-path-traversal
    std::fs::File::open("fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::OpenOptions::new().write(true).open(&path);
    // ok: rust-ipc-path-traversal
    std::fs::OpenOptions::new().write(true).open("fixed.txt");
    let mut options = std::fs::OpenOptions::new();
    // ruleid: rust-ipc-path-traversal
    options.write(true).open(&path);
    // ok: rust-ipc-path-traversal
    options.write(true).open("fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::File::create(&path);
    // ok: rust-ipc-path-traversal
    std::fs::File::create("fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::read_dir(&path);
    // ok: rust-ipc-path-traversal
    std::fs::read_dir("fixed-directory");
    // ruleid: rust-ipc-path-traversal
    std::fs::remove_dir_all(&path);
    // ok: rust-ipc-path-traversal
    std::fs::remove_dir_all("fixed-directory");
    // ruleid: rust-ipc-path-traversal
    std::fs::hard_link(&path, "fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::fs::hard_link("fixed.txt", &path);
    // ok: rust-ipc-path-traversal
    std::fs::hard_link("fixed.txt", "other.txt");
    // ruleid: rust-ipc-path-traversal
    std::os::unix::fs::symlink(&path, "fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::os::unix::fs::symlink("fixed.txt", &path);
    // ok: rust-ipc-path-traversal
    std::os::unix::fs::symlink("fixed.txt", "other.txt");
    // ruleid: rust-ipc-path-traversal
    std::os::windows::fs::symlink_file(&path, "fixed.txt");
    // ruleid: rust-ipc-path-traversal
    std::os::windows::fs::symlink_file("fixed.txt", &path);
    // ok: rust-ipc-path-traversal
    std::os::windows::fs::symlink_file("fixed.txt", "other.txt");
    // ruleid: rust-ipc-path-traversal
    std::os::windows::fs::symlink_dir(&path, "fixed-directory");
    // ruleid: rust-ipc-path-traversal
    std::os::windows::fs::symlink_dir("fixed-directory", &path);
    // ok: rust-ipc-path-traversal
    std::os::windows::fs::symlink_dir("fixed-directory", "other-directory");
}

#[tauri::command]
async fn tokio_filesystem_sinks(path: String) {
    // ruleid: rust-ipc-path-traversal
    tokio::fs::read_to_string(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::read_to_string("fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::write(&path, "content").await;
    // ok: rust-ipc-path-traversal
    tokio::fs::write("fixed.txt", "content").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::remove_file(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::remove_file("fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::copy(&path, "fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::copy("fixed.txt", &path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::copy("fixed.txt", "other.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::rename(&path, "fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::rename("fixed.txt", &path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::rename("fixed.txt", "other.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::File::open(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::File::open("fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::OpenOptions::new().write(true).open(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::OpenOptions::new().write(true).open("fixed.txt").await;
    let mut options = tokio::fs::OpenOptions::new();
    // ruleid: rust-ipc-path-traversal
    options.write(true).open(&path).await;
    // ok: rust-ipc-path-traversal
    options.write(true).open("fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::File::create(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::File::create("fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::read_dir(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::read_dir("fixed-directory").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::remove_dir_all(&path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::remove_dir_all("fixed-directory").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::hard_link(&path, "fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::hard_link("fixed.txt", &path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::hard_link("fixed.txt", "other.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::symlink(&path, "fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::symlink("fixed.txt", &path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::symlink("fixed.txt", "other.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::symlink_file(&path, "fixed.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::symlink_file("fixed.txt", &path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::symlink_file("fixed.txt", "other.txt").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::symlink_dir(&path, "fixed-directory").await;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::symlink_dir("fixed-directory", &path).await;
    // ok: rust-ipc-path-traversal
    tokio::fs::symlink_dir("fixed-directory", "other-directory").await;
}

#[tauri::command]
async fn write_content(content: String) {
    // ok: rust-ipc-path-traversal
    tokio::fs::write("exports/fixed.txt", content).await;
}

#[tauri::command]
async fn open_with(remote_path: String) {
    let intent = OpenWithIntent::resolve(&remote_path)?;
    // ruleid: rust-ipc-path-traversal
    tokio::fs::read(&intent.remote_path).await;
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

fn tls() {
    // ruleid: rust-disabled-tls-verification
    client.danger_accept_invalid_certs(true);
    // ruleid: rust-disabled-tls-verification
    client.danger_accept_invalid_hostnames(true);
    // ok: rust-disabled-tls-verification
    client.danger_accept_invalid_certs(false);
    // ok: rust-disabled-tls-verification
    client.danger_accept_invalid_hostnames(false);
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

// ruleid: rust-credential-debug
#[derive(Debug)]
pub(crate) struct LeakyPrivateKey {
    private_key: Vec<u8>,
}

// ruleid: rust-credential-debug
#[derive(Debug)]
struct LeakyOptionalKey {
    private_key: Option<Vec<u8>>,
}

// ruleid: rust-credential-debug
#[derive(Debug)]
enum NamedSecret {
    Value { private_key: Vec<u8> },
}

// ruleid: rust-credential-debug
#[derive(Debug)]
pub enum PublicNamedSecret {
    Value { access_token: Option<Vec<u8>> },
}

// ruleid: rust-credential-debug
#[derive(Debug)]
pub(crate) struct SecretList {
    passwords: Vec<String>,
}

// ruleid: rust-credential-debug
#[derive(Debug)]
pub(crate) enum NamedSecretList {
    Values { passwords: Vec<String> },
}

// ok: rust-credential-debug
#[derive(Clone, Debug)]
pub struct RedactedConfig {
    pub host: String,
    pub password: SensitiveString,
}

// ok: rust-credential-debug
#[derive(Debug)]
enum RedactedSecrets {
    Values {
        passwords: Vec<SensitiveString>,
        private_key: RedactedBytes,
    },
}

// ok: rust-credential-debug
#[derive(Clone)]
pub struct NoDebugConfig {
    pub password: String,
}

// ok: rust-credential-debug
#[derive(Clone)]
enum NoDebugSecret {
    Value { private_key: Vec<u8> },
}

fn channels() {
    // ruleid: rust-unbounded-channel
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    // ruleid: rust-unbounded-channel
    let (sender, receiver) = mpsc::unbounded_channel();
    // ruleid: rust-unbounded-channel
    let (sender, receiver) = unbounded_channel();
    // ruleid: rust-unbounded-channel
    let (release, wait) = std::sync::mpsc::channel();
    // ruleid: rust-unbounded-channel
    let (sender, receiver) = crossbeam_channel::unbounded();
    // ok: rust-unbounded-channel
    let (sender, receiver) = tokio::sync::mpsc::channel(16);
    // ok: rust-unbounded-channel
    let (sender, receiver) = crossbeam_channel::bounded(16);
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
