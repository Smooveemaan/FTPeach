use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSshKey {
    path: String,
    is_rsa: bool,
}

fn prefix_identifies_rsa_private_key(prefix: &str) -> bool {
    prefix.contains("BEGIN RSA PRIVATE KEY")
        || prefix.lines().next().is_some_and(|line| {
            line.starts_with("PuTTY-User-Key-File-") && line.contains("ssh-rsa")
        })
}

fn is_rsa_private_key(path: &std::path::Path) -> bool {
    use russh::keys::ssh_key::{Algorithm, PrivateKey};
    use std::io::Read;

    if let Ok(key) = PrivateKey::read_openssh_file(path) {
        return matches!(key.algorithm(), Algorithm::Rsa { .. });
    }

    // OpenSSH's parser does not handle legacy PKCS#1 PEM. PuTTY files expose
    // the algorithm in their first line, so a small bounded prefix is enough.
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut prefix = String::new();
    let _ = file.take(4096).read_to_string(&mut prefix);
    prefix_identifies_rsa_private_key(&prefix)
}

#[tauri::command]
pub async fn dialog_select_local_dir(
    app: AppHandle,
    approved: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
) -> Result<Option<String>, crate::ipc::CommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let selected = rx.await.ok().flatten().map(|p| p.to_string());
    if let Some(path) = selected.as_deref() {
        approved.approve_from_dialog(std::path::Path::new(path));
    }
    Ok(selected)
}

#[tauri::command]
pub async fn dialog_select_key_file(
    app: AppHandle,
    approved: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
) -> Result<Option<SelectedSshKey>, crate::ipc::CommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("All files", &["*"])
        .add_filter("SSH keys", &["pem", "ppk", "key"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let selected = rx.await.ok().flatten().map(|p| p.to_string());
    Ok(selected.map(|path| {
        approved.approve_from_dialog(std::path::Path::new(&path));
        SelectedSshKey {
            is_rsa: is_rsa_private_key(std::path::Path::new(&path)),
            path,
        }
    }))
}

#[tauri::command]
pub async fn dialog_select_ca_cert_file(
    app: AppHandle,
    approved: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
) -> Result<Option<String>, crate::ipc::CommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Certificates", &["pem", "crt", "cer"])
        .add_filter("All files", &["*"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let selected = rx.await.ok().flatten().map(|p| p.to_string());
    if let Some(path) = selected.as_deref() {
        approved.approve_from_dialog(std::path::Path::new(path));
    }
    Ok(selected)
}

#[tauri::command]
pub async fn dialog_select_application(
    app: AppHandle,
    approved: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
) -> Result<Option<String>, crate::ipc::CommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Applications", &["exe", "com", "bat", "cmd"])
        .add_filter("All files", &["*"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let selected = rx.await.ok().flatten().map(|p| p.to_string());
    if let Some(path) = selected.as_deref() {
        approved.approve_from_dialog(std::path::Path::new(path));
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::prefix_identifies_rsa_private_key;

    #[test]
    fn recognizes_legacy_pem_and_putty_rsa_keys() {
        assert!(prefix_identifies_rsa_private_key(
            "-----BEGIN RSA PRIVATE KEY-----\n..."
        ));
        assert!(prefix_identifies_rsa_private_key(
            "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none"
        ));
    }

    #[test]
    fn does_not_label_ed25519_as_rsa() {
        assert!(!prefix_identifies_rsa_private_key(
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none"
        ));
        assert!(!prefix_identifies_rsa_private_key(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n..."
        ));
    }
}
