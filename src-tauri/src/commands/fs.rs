use crate::ipc::{CommandError, ErrorCode, OkResult, err, ok};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validate_copy_relationship, validate_read_source,
    validate_write_destination, validated_delete_target,
};
use crate::local_fs::fs_listing::{self, FsEntry};
use crate::local_fs::mutations::guard as mutation_guard;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[tauri::command]
pub async fn fs_validate_copy(source_path: String, dest_path: String) -> OkResult {
    match validate_copy_relationship(Path::new(&source_path), Path::new(&dest_path)) {
        Ok(()) => ok(),
        Err(error) => err(error),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum FsListResult {
    Ok {
        ok: bool,
        path: String,
        entries: Vec<FsEntry>,
    },
    Err {
        ok: bool,
        error: CommandError,
    },
}

#[tauri::command]
pub async fn fs_list(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: Option<String>,
) -> Result<FsListResult, CommandError> {
    let target = match local_path.filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => match dirs_home() {
            Some(h) => h,
            None => {
                return Ok(FsListResult::Err {
                    ok: false,
                    error: CommandError::new(ErrorCode::NotFound, "Home directory not found"),
                });
            }
        },
    };
    validate_read_source(&target)
        .await
        .map_err(CommandError::from)?;
    match fs_listing::list_directory(&target).await {
        Ok(entries) => {
            for entry in &entries {
                approved_paths.approve_from_listing(&target.join(&entry.name));
            }
            Ok(FsListResult::Ok {
                ok: true,
                path: target.to_string_lossy().into_owned(),
                entries,
            })
        }
        Err(e) => Ok(FsListResult::Err {
            ok: false,
            error: CommandError::from(e),
        }),
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

#[tauri::command]
pub fn fs_homedir() -> String {
    dirs_home()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct Drive {
    path: String,
    label: String,
}

#[tauri::command]
pub async fn fs_drives() -> Vec<Drive> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let letter = letter as char;
        let path = format!("{letter}:\\");
        if tokio::fs::metadata(&path).await.is_ok() {
            drives.push(Drive {
                path,
                label: format!("{letter}:"),
            });
        }
    }
    drives
}

#[tauri::command]
pub async fn fs_mkdir(local_path: String) -> OkResult {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&local_path) {
        Ok(lease) => lease,
        // Kept typed: `err` would flatten the "busy" code into prose.
        Err(error) => {
            return OkResult::Err {
                ok: false,
                error: error.into(),
            };
        }
    };
    let _mutation = mutation_guard().lock().await;
    if let Err(error) = validate_write_destination(Path::new(&local_path)).await {
        return err(error);
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&local_path)) {
        return err(error);
    }
    match tokio::fs::create_dir_all(&local_path).await {
        Ok(()) => {
            if let Err(error) = validate_write_destination(Path::new(&local_path)).await {
                return err(error);
            }
            match ensure_path_no_reparse_points_now(Path::new(&local_path)) {
                Ok(()) => ok(),
                Err(error) => err(error),
            }
        }
        Err(e) => err(e),
    }
}

#[tauri::command]
pub async fn fs_rename(old_path: String, new_path: String) -> OkResult {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&old_path) {
        Ok(lease) => lease,
        // Kept typed: `err` would flatten the "busy" code into prose.
        Err(error) => {
            return OkResult::Err {
                ok: false,
                error: error.into(),
            };
        }
    };
    let _lease1 = match crate::local_fs::target_reservation::Reservation::acquire(&new_path) {
        Ok(lease) => lease,
        // Kept typed: `err` would flatten the "busy" code into prose.
        Err(error) => {
            return OkResult::Err {
                ok: false,
                error: error.into(),
            };
        }
    };
    let _mutation = mutation_guard().lock().await;
    if let Err(error) = validate_copy_relationship(Path::new(&old_path), Path::new(&new_path)) {
        return err(error);
    }
    let old_path = match validated_delete_target(Path::new(&old_path)).await {
        Ok(Some((path, _))) => path,
        Ok(None) => return err("Source does not exist"),
        Err(error) => return err(error),
    };
    if let Err(error) = validate_write_destination(Path::new(&new_path)).await {
        return err(error);
    }
    // Repeat both checks immediately before the path-based operation. This
    // catches a component replaced after the initial canonical validation.
    let old_path = match validated_delete_target(&old_path).await {
        Ok(Some((path, _))) => path,
        Ok(None) => return err("Source does not exist"),
        Err(error) => return err(error),
    };
    if let Err(error) = validate_write_destination(Path::new(&new_path)).await {
        return err(error);
    }
    if let Err(error) = ensure_path_no_reparse_points_now(&old_path) {
        return err(error);
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&new_path)) {
        return err(error);
    }
    match tokio::fs::rename(&old_path, &new_path).await {
        Ok(()) => ok(),
        Err(e) => err(e),
    }
}

#[tauri::command]
pub async fn fs_copy_file(
    source_path: String,
    dest_path: String,
    overwrite: Option<bool>,
) -> OkResult {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&dest_path) {
        Ok(lease) => lease,
        // Kept typed: `err` would flatten the "busy" code into prose.
        Err(error) => {
            return OkResult::Err {
                ok: false,
                error: error.into(),
            };
        }
    };
    let _mutation = mutation_guard().lock().await;
    if let Err(error) = validate_copy_relationship(Path::new(&source_path), Path::new(&dest_path)) {
        return err(error);
    }
    if let Err(error) = validate_read_source(Path::new(&source_path)).await {
        return err(error);
    }
    if let Err(error) = validate_write_destination(Path::new(&dest_path)).await {
        return err(error);
    }
    if let Err(error) = validate_read_source(Path::new(&source_path)).await {
        return err(error);
    }
    if let Err(error) = validate_write_destination(Path::new(&dest_path)).await {
        return err(error);
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&source_path)) {
        return err(error);
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&dest_path)) {
        return err(error);
    }
    if !overwrite.unwrap_or(false) {
        let result: anyhow::Result<()> = async {
            let mut source = tokio::fs::File::open(&source_path).await?;
            let mut destination = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest_path)
                .await?;
            tokio::io::copy(&mut source, &mut destination).await?;
            Ok(())
        }
        .await;
        return match result {
            Ok(()) => ok(),
            Err(error) => err(error),
        };
    }
    match tokio::fs::copy(&source_path, &dest_path).await {
        Ok(_) => ok(),
        Err(e) => err(e),
    }
}

#[tauri::command]
pub async fn fs_delete(
    window: tauri::WebviewWindow,
    authorization: tauri::State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    local_path: String,
    permanent: bool,
) -> Result<OkResult, CommandError> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "fs_delete",
        &local_path,
    )?;
    Ok(fs_delete_authorized(local_path, permanent).await)
}

async fn fs_delete_authorized(local_path: String, permanent: bool) -> OkResult {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&local_path) {
        Ok(lease) => lease,
        // Kept typed: `err` would flatten the "busy" code into prose.
        Err(error) => {
            return OkResult::Err {
                ok: false,
                error: error.into(),
            };
        }
    };
    let _mutation = mutation_guard().lock().await;
    if permanent {
        return crate::local_fs::fs_delete::fs_delete_permanently(local_path).await;
    }

    #[cfg(windows)]
    {
        crate::local_fs::recycle_bin::fs_move_to_recycle_bin(local_path).await
    }

    #[cfg(not(windows))]
    {
        crate::local_fs::fs_delete::fs_delete_permanently(local_path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn protected_app_data_public_commands() {
        const FIXTURE: &str = "FTPEACH_P0_GUARD_FIXTURE";
        if let Some(root) = std::env::var_os(FIXTURE) {
            let root = PathBuf::from(root);
            let app = root.join("roaming/FTPeach");
            let outside = root.join("outside.txt");
            let mut directories = vec![
                app.clone(),
                std::fs::canonicalize(&app).unwrap(),
                PathBuf::from(app.to_string_lossy().to_uppercase()),
                app.join("nested/.."),
            ];
            let text = app.to_string_lossy();
            let unc = PathBuf::from(format!(r"\\localhost\{}${}", &text[..1], &text[2..]));
            if std::env::var_os("FTPEACH_REQUIRE_UNC_FIXTURES").is_some() {
                assert!(
                    unc.exists(),
                    "Required local SMB fixture is unavailable: {}",
                    unc.display()
                );
            }
            if unc.exists() {
                directories.push(std::fs::canonicalize(&unc).unwrap());
                directories.push(unc);
            }
            for directory in directories {
                let secret = directory.join("secret");
                assert!(matches!(
                    fs_copy_file(
                        secret.to_string_lossy().into_owned(),
                        outside.to_string_lossy().into_owned(),
                        None
                    )
                    .await,
                    OkResult::Err { .. }
                ));
                assert!(matches!(
                    fs_create_file(directory.join("missing").to_string_lossy().into_owned()).await,
                    OkResult::Err { .. }
                ));
                assert!(matches!(
                    fs_mkdir(
                        directory
                            .join("missing/child")
                            .to_string_lossy()
                            .into_owned()
                    )
                    .await,
                    OkResult::Err { .. }
                ));
                assert!(matches!(
                    fs_delete_authorized(secret.to_string_lossy().into_owned(), true).await,
                    OkResult::Err { .. }
                ));
                assert!(matches!(
                    fs_delete_authorized(directory.to_string_lossy().into_owned(), true).await,
                    OkResult::Err { .. }
                ));
                assert_eq!(std::fs::read(app.join("secret")).unwrap(), b"keep");
            }
            assert!(matches!(
                fs_delete_authorized(root.join("roaming").to_string_lossy().into_owned(), true)
                    .await,
                OkResult::Err { .. }
            ));
            assert!(!outside.exists());
            return;
        }
        let root = std::env::temp_dir().join(format!("ftpeach-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("roaming/FTPeach/nested")).unwrap();
        std::fs::write(root.join("roaming/FTPeach/secret"), b"keep").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::fs::tests::protected_app_data_public_commands",
                "--nocapture",
            ])
            .env(FIXTURE, &root)
            .env("APPDATA", root.join("roaming"))
            .env("USERPROFILE", &root)
            .output()
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn public_delete_command_keeps_the_normal_file_manager_scenario() {
        let root = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(root.join("folder"))
            .await
            .unwrap();
        tokio::fs::write(root.join("folder").join("file.txt"), b"test")
            .await
            .unwrap();

        let result =
            fs_delete_authorized(root.join("folder").to_string_lossy().into_owned(), false).await;

        assert!(matches!(result, OkResult::Ok { ok: true }), "{result:?}");
        assert!(!root.join("folder").exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn permanent_delete_bypasses_the_recycle_bin() {
        let root = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let file = root.join("permanent.txt");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&file, b"test").await.unwrap();

        let result = fs_delete_authorized(file.to_string_lossy().into_owned(), true).await;

        assert!(matches!(result, OkResult::Ok { ok: true }), "{result:?}");
        assert!(!file.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}

#[tauri::command]
pub async fn fs_create_file(local_path: String) -> OkResult {
    use tokio::io::AsyncWriteExt;
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&local_path) {
        Ok(lease) => lease,
        // Kept typed: `err` would flatten the "busy" code into prose.
        Err(error) => {
            return OkResult::Err {
                ok: false,
                error: error.into(),
            };
        }
    };
    let _mutation = mutation_guard().lock().await;
    if let Err(error) = validate_write_destination(Path::new(&local_path)).await {
        return err(error);
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&local_path)) {
        return err(error);
    }
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&local_path)
        .await
    {
        Ok(mut f) => {
            let _ = f.flush().await;
            ok()
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => err("File already exists"),
        Err(e) => err(e),
    }
}

#[tauri::command]
pub async fn fs_is_dir(local_path: String) -> bool {
    tokio::fs::metadata(&local_path)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

async fn open_validated_path(
    app: tauri::AppHandle,
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: String,
    kind: crate::local_fs::local_open::OpenKind,
) -> Result<OkResult, CommandError> {
    let canonical = approved_paths.validate(Path::new(&local_path), kind)?;
    if kind == crate::local_fs::local_open::OpenKind::Reveal {
        #[cfg(windows)]
        let result = std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", canonical.to_string_lossy()))
            .spawn()
            .map(|_| ());
        #[cfg(not(windows))]
        let result = {
            use tauri_plugin_opener::OpenerExt;
            let parent = canonical.parent().unwrap_or(&canonical);
            app.opener()
                .open_path(parent.to_string_lossy().into_owned(), None::<String>)
        };
        return match result {
            Ok(()) => Ok(ok()),
            Err(e) => Ok(err(e)),
        };
    }
    use tauri_plugin_opener::OpenerExt;
    match app
        .opener()
        .open_path(canonical.to_string_lossy().into_owned(), None::<String>)
    {
        Ok(()) => Ok(ok()),
        Err(e) => Ok(err(e)),
    }
}

macro_rules! open_command {
    ($name:ident, $operation:literal, $kind:expr_2021) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            window: tauri::WebviewWindow,
            authorization: tauri::State<'_, crate::security::sensitive::AuthorizationState>,
            approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
            authorization_token: String,
            local_path: String,
        ) -> Result<OkResult, CommandError> {
            crate::security::sensitive::consume(
                &window,
                &authorization,
                &authorization_token,
                $operation,
                &local_path,
            )?;
            open_validated_path(app, approved_paths, local_path, $kind).await
        }
    };
}

open_command!(
    fs_reveal_path,
    "fs_reveal_path",
    crate::local_fs::local_open::OpenKind::Reveal
);
open_command!(
    fs_open_document,
    "fs_open_document",
    crate::local_fs::local_open::OpenKind::Document
);
open_command!(
    fs_execute_path,
    "fs_execute_path",
    crate::local_fs::local_open::OpenKind::Execute
);
