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
async fn safe_name(name: String) {
    let path = std::path::Path::new("exports").join(safe_temp_name(&name));
    // ok: rust-ipc-path-traversal
    tokio::fs::remove_file(path).await;
}
