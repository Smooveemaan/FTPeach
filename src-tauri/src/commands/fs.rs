use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::filesystem_safety::{
    ensure_path_no_reparse_points_now, validate_copy_relationship, validate_read_source,
    validate_write_destination, validated_delete_target,
};
use crate::local_fs::fs_listing::{self, FsEntry};
use crate::local_fs::mutations::guard as mutation_guard;
use serde::Serialize;
use std::path::{Path, PathBuf};

// Resolving a path is the first thing that can reach the network: a UNC
// address makes Windows contact the server before any later check runs. The
// thin wrappers below refuse an unconfirmed share from the path's text, then
// hand the work to the unchanged body.
#[tauri::command]
pub async fn fs_validate_copy(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    source_path: String,
    dest_path: String,
) -> CommandResult<()> {
    approved_paths.preflight(Path::new(&source_path))?;
    approved_paths.preflight(Path::new(&dest_path))?;
    Ok(validate_copy_relationship(
        Path::new(&source_path),
        Path::new(&dest_path),
    )?)
}

/// A local folder's entries, and the path they were listed under.
#[derive(Serialize)]
pub struct FsList {
    path: String,
    entries: Vec<FsEntry>,
}

#[tauri::command]
pub async fn fs_list(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: Option<String>,
    request_key: Option<String>,
) -> CommandResult<FsList> {
    let request = fs_listing::ListingRequest::start(request_key).map_err(CommandError::from)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let listing = async {
        static REQUEST_SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
            std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
        let permit = REQUEST_SLOTS
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))?;
        let target = match local_path.filter(|s| !s.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => match dirs_home() {
                Some(h) => h,
                None => {
                    return Err(CommandError::new(
                        ErrorCode::NotFound,
                        "Home directory not found",
                    ));
                }
            },
        };
        approved_paths.preflight(&target)?;
        validate_read_source(&target)
            .await
            .map_err(CommandError::from)?;
        match fs_listing::list_directory(&target, &request.token).await {
            Ok(entries) => {
                // Canonicalization may block on SMB. Bound blocking workers and
                // keep their permit until the OS call actually returns.
                let approvals = approved_paths.inner().clone();
                let approval_target = target.clone();
                let token = request.token.clone();
                let entries = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    for entry in &entries {
                        if token.is_cancelled() {
                            break;
                        }
                        approvals.approve_from_listing(&approval_target.join(&entry.name));
                    }
                    entries
                })
                .await
                .map_err(|error| CommandError::new(ErrorCode::Internal, error.to_string()))?;
                Ok(FsList {
                    path: target.to_string_lossy().into_owned(),
                    entries,
                })
            }
            Err(e) => Err(CommandError::from(e)),
        }
    };
    tokio::select! {
        biased;
        _ = request.token.cancelled() => Err(CommandError::new(ErrorCode::Cancelled, "Local listing cancelled")),
        result = tokio::time::timeout_at(deadline, listing) => result.unwrap_or_else(|_| Err(CommandError::new(ErrorCode::TimedOut, "Local listing deadline exceeded"))),
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

#[tauri::command]
pub fn fs_cancel_list(request_key: String) {
    fs_listing::ListingRequest::cancel(&request_key);
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
pub async fn fs_mkdir(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: String,
) -> CommandResult<()> {
    approved_paths.preflight(Path::new(&local_path))?;
    fs_mkdir_checked(local_path).await
}

async fn fs_mkdir_checked(local_path: String) -> CommandResult<()> {
    Ok(crate::local_fs::local_create::create_dir(Path::new(&local_path)).await?)
}

#[tauri::command]
pub async fn fs_rename(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    old_path: String,
    new_path: String,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    approved_paths.preflight(Path::new(&old_path))?;
    approved_paths.preflight(Path::new(&new_path))?;
    fs_rename_checked(old_path, new_path, overwrite).await
}

async fn fs_rename_checked(
    old_path: String,
    new_path: String,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&old_path) {
        Ok(lease) => lease,
        Err(error) => return Err(error.into()),
    };
    // One lease already protects both names when their reservation keys match.
    let same_key = crate::local_fs::target_reservation::key(None, &old_path)
        == crate::local_fs::target_reservation::key(None, &new_path);
    let _lease1 = match if same_key {
        Ok(None)
    } else {
        crate::local_fs::target_reservation::Reservation::acquire(&new_path).map(Some)
    } {
        Ok(lease) => lease,
        Err(error) => return Err(error.into()),
    };
    let _mutation = mutation_guard().write().await;
    let case_only =
        cfg!(windows) && old_path != new_path && old_path.to_lowercase() == new_path.to_lowercase();
    if !case_only
        && let Err(error) = validate_copy_relationship(Path::new(&old_path), Path::new(&new_path))
    {
        return Err(error.into());
    }
    let old_path = match validated_delete_target(Path::new(&old_path)).await {
        Ok(Some((path, _))) => path,
        Ok(None) => return Err(anyhow::anyhow!("Source does not exist").into()),
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = validate_write_destination(Path::new(&new_path)).await {
        return Err(error.into());
    }
    // Repeat both checks immediately before the path-based operation. This
    // catches a component replaced after the initial canonical validation.
    let old_path = match validated_delete_target(&old_path).await {
        Ok(Some((path, _))) => path,
        Ok(None) => return Err(anyhow::anyhow!("Source does not exist").into()),
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = validate_write_destination(Path::new(&new_path)).await {
        return Err(error.into());
    }
    if let Err(error) = ensure_path_no_reparse_points_now(&old_path) {
        return Err(error.into());
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&new_path)) {
        return Err(error.into());
    }
    // Only an explicit `true` may replace: a caller that omits the flag has
    // not resolved a conflict, so an existing target must survive.
    let overwrite = overwrite == Some(true);
    let result = if overwrite {
        tokio::fs::rename(&old_path, &new_path)
            .await
            .map_err(anyhow::Error::from)
    } else {
        crate::protocol::transfer_file::rename_no_replace(&old_path, Path::new(&new_path)).await
    };
    #[cfg(windows)]
    let result = match result {
        Err(error) if crate::local_fs::verified_move::is_cross_volume(&error) => {
            tokio::task::spawn_blocking(move || {
                crate::local_fs::verified_move::copy_verify_delete(
                    &old_path,
                    Path::new(&new_path),
                    overwrite,
                )
            })
            .await
            .unwrap_or_else(|error| Err(error.into()))
        }
        other => other,
    };
    Ok(result?)
}

#[tauri::command]
pub async fn fs_copy_file(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    source_path: String,
    dest_path: String,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    approved_paths.preflight(Path::new(&source_path))?;
    approved_paths.preflight(Path::new(&dest_path))?;
    fs_copy_file_checked(source_path, dest_path, overwrite).await
}

async fn fs_copy_file_checked(
    source_path: String,
    dest_path: String,
    overwrite: Option<bool>,
) -> CommandResult<()> {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&dest_path) {
        Ok(lease) => lease,
        Err(error) => return Err(error.into()),
    };
    let _mutation = mutation_guard().write().await;
    if let Err(error) = validate_copy_relationship(Path::new(&source_path), Path::new(&dest_path)) {
        return Err(error.into());
    }
    if let Err(error) = validate_read_source(Path::new(&source_path)).await {
        return Err(error.into());
    }
    if let Err(error) = validate_write_destination(Path::new(&dest_path)).await {
        return Err(error.into());
    }
    if let Err(error) = validate_read_source(Path::new(&source_path)).await {
        return Err(error.into());
    }
    if let Err(error) = validate_write_destination(Path::new(&dest_path)).await {
        return Err(error.into());
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&source_path)) {
        return Err(error.into());
    }
    if let Err(error) = ensure_path_no_reparse_points_now(Path::new(&dest_path)) {
        return Err(error.into());
    }
    Ok(crate::local_fs::staged_copy::copy_file(
        Path::new(&source_path),
        Path::new(&dest_path),
        overwrite == Some(true),
        &tokio_util::sync::CancellationToken::new(),
    )
    .await?)
}

#[tauri::command]
pub async fn fs_delete(
    window: tauri::WebviewWindow,
    authorization: tauri::State<'_, crate::security::sensitive::AuthorizationState>,
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    authorization_token: String,
    local_path: String,
    permanent: bool,
) -> CommandResult<()> {
    // Before anything resolves, stats or opens the path: resolving a UNC
    // path is itself network access, and even a rejected token would have
    // canonicalized it first.
    approved_paths.preflight(Path::new(&local_path))?;
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "fs_delete",
        &local_path,
    )?;
    fs_delete_authorized(local_path, permanent).await
}

async fn fs_delete_authorized(local_path: String, permanent: bool) -> CommandResult<()> {
    let _lease0 = match crate::local_fs::target_reservation::Reservation::acquire(&local_path) {
        Ok(lease) => lease,
        Err(error) => return Err(error.into()),
    };
    let _mutation = mutation_guard().write().await;
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
    async fn create_commands_keep_the_service_error_codes() {
        let root =
            std::env::temp_dir().join(format!("ftpeach-create-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("held.txt").to_string_lossy().into_owned();
        let code = |result: CommandResult<()>| result.err().map(|error| error.code);
        {
            let _held = crate::local_fs::target_reservation::Reservation::acquire(&file).unwrap();
            assert_eq!(
                code(fs_create_file_checked(file.clone()).await),
                Some(ErrorCode::Busy)
            );
            assert_eq!(
                code(fs_mkdir_checked(file.clone()).await),
                Some(ErrorCode::Busy)
            );
        }
        assert_eq!(code(fs_create_file_checked(file.clone()).await), None);
        assert_eq!(
            code(fs_create_file_checked(file.clone()).await),
            Some(ErrorCode::AlreadyExists)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

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
                assert!(
                    (fs_copy_file_checked(
                        secret.to_string_lossy().into_owned(),
                        outside.to_string_lossy().into_owned(),
                        None
                    )
                    .await)
                        .is_err()
                );
                assert!(
                    (fs_create_file_checked(
                        directory.join("missing").to_string_lossy().into_owned()
                    )
                    .await)
                        .is_err()
                );
                assert!(
                    (fs_mkdir_checked(
                        directory
                            .join("missing/child")
                            .to_string_lossy()
                            .into_owned()
                    )
                    .await)
                        .is_err()
                );
                assert!(
                    (fs_delete_authorized(secret.to_string_lossy().into_owned(), true).await)
                        .is_err()
                );
                assert!(
                    (fs_delete_authorized(directory.to_string_lossy().into_owned(), true).await)
                        .is_err()
                );
                assert_eq!(std::fs::read(app.join("secret")).unwrap(), b"keep");
            }
            assert!(
                (fs_delete_authorized(root.join("roaming").to_string_lossy().into_owned(), true)
                    .await)
                    .is_err()
            );
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

        assert!(result.is_ok(), "{result:?}");
        assert!(!root.join("folder").exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn rename_and_copy_without_an_overwrite_decision_keep_the_existing_target() {
        let root = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let source = root.join("source.txt");
        let target = root.join("target.txt");
        tokio::fs::write(&source, b"source").await.unwrap();
        tokio::fs::write(&target, b"external").await.unwrap();
        let path = |p: &Path| p.to_string_lossy().into_owned();

        for overwrite in [None, Some(false)] {
            let result = fs_rename_checked(path(&source), path(&target), overwrite).await;
            // The code the pane answers with its replace prompt.
            assert_eq!(
                result.unwrap_err().code,
                crate::ipc::ErrorCode::AlreadyExists,
                "{overwrite:?}"
            );
            let result = fs_copy_file_checked(path(&source), path(&target), overwrite).await;
            assert!(result.is_err(), "{overwrite:?}");
            assert_eq!(std::fs::read(&source).unwrap(), b"source");
            assert_eq!(std::fs::read(&target).unwrap(), b"external");
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);

        let result = fs_copy_file_checked(path(&source), path(&target), Some(true)).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(std::fs::read(&target).unwrap(), b"source");
        tokio::fs::write(&target, b"external").await.unwrap();
        let result = fs_rename_checked(path(&source), path(&target), Some(true)).await;
        assert!(result.is_ok(), "{result:?}");
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"source");
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn permanent_delete_bypasses_the_recycle_bin() {
        let root = std::env::temp_dir().join(format!("ftpeach-fs-test-{}", uuid::Uuid::new_v4()));
        let file = root.join("permanent.txt");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&file, b"test").await.unwrap();

        let result = fs_delete_authorized(file.to_string_lossy().into_owned(), true).await;

        assert!(result.is_ok(), "{result:?}");
        assert!(!file.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}

#[tauri::command]
pub async fn fs_create_file(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: String,
) -> CommandResult<()> {
    approved_paths.preflight(Path::new(&local_path))?;
    fs_create_file_checked(local_path).await
}

async fn fs_create_file_checked(local_path: String) -> CommandResult<()> {
    Ok(crate::local_fs::local_create::create_file(Path::new(&local_path)).await?)
}

/// How many probes of a network path may be in flight at once.
///
/// A share that stops answering leaves its `metadata` call blocked inside
/// Windows, and a timeout on the future does not take that OS worker back.
/// What can be bounded is how many of them there are, so a wedged share
/// costs a handful of threads rather than one per attempt.
static NETWORK_PROBES: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(4));

#[tauri::command]
pub async fn fs_is_dir(
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: String,
) -> Result<bool, CommandError> {
    // A `metadata` call is enough to reach a share, so an unconfirmed one is
    // refused rather than answered.
    approved_paths.preflight(Path::new(&local_path))?;
    let probe =
        async {
            let _permit =
                if crate::local_fs::local_open::is_network_path(Path::new(&local_path)) {
                    Some(NETWORK_PROBES.acquire().await.map_err(|error| {
                        CommandError::new(ErrorCode::Internal, error.to_string())
                    })?)
                } else {
                    None
                };
            Ok::<bool, CommandError>(
                tokio::fs::metadata(&local_path)
                    .await
                    .map(|m| m.is_dir())
                    .unwrap_or(false),
            )
        };
    tokio::time::timeout(std::time::Duration::from_secs(10), probe)
        .await
        .unwrap_or(Ok(false))
}

async fn open_validated_path(
    app: tauri::AppHandle,
    approved_paths: tauri::State<'_, crate::local_fs::local_open::ApprovedLocalPaths>,
    local_path: String,
    kind: crate::local_fs::local_open::OpenKind,
) -> CommandResult<()> {
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
        return Ok(result.map_err(anyhow::Error::from)?);
    }
    use tauri_plugin_opener::OpenerExt;
    Ok(app
        .opener()
        .open_path(canonical.to_string_lossy().into_owned(), None::<String>)
        .map_err(anyhow::Error::from)?)
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
        ) -> CommandResult<()> {
            approved_paths.preflight(Path::new(&local_path))?;
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

#[cfg(all(test, windows))]
mod drag_move_tests {
    use super::*;

    #[tokio::test]
    async fn case_only_rename_keeps_contents_and_respects_other_owners() {
        let dir = std::env::temp_dir().join(format!("ftpeach-case-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let source = dir.join("a.txt");
        let target = dir.join("A.txt");
        std::fs::write(&source, b"keep").unwrap();
        let source = source.to_string_lossy().into_owned();
        let target = target.to_string_lossy().into_owned();
        let lease = crate::local_fs::target_reservation::Reservation::acquire(&source).unwrap();
        assert!(matches!(
            fs_rename_checked(source.clone(), target.clone(), None).await,
            Err(error) if error.code == crate::ipc::ErrorCode::Busy
        ));
        drop(lease);
        assert!(matches!(
            fs_rename_checked(source, target.clone(), None).await,
            Ok(())
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .file_name(),
            "A.txt"
        );
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[tokio::test]
    async fn move_without_overwrite_preserves_both_files_and_then_moves_to_free_target() {
        let dir = std::env::temp_dir().join(format!("ftpeach-drag-move-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let source = dir.join("source.txt");
        let target = dir.join("target.txt");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&target, b"external").unwrap();
        let result = fs_rename_checked(
            source.to_string_lossy().into(),
            target.to_string_lossy().into(),
            Some(false),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&target).unwrap(), b"external");
        std::fs::remove_file(&target).unwrap();
        let result = fs_rename_checked(
            source.to_string_lossy().into(),
            target.to_string_lossy().into(),
            Some(false),
        )
        .await;
        assert!(result.is_ok());
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"source");
        std::fs::remove_file(&target).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }
    #[tokio::test]
    #[ignore = "requires an explicitly configured writable second volume"]
    async fn cross_volume_disk_move() {
        let destination_root =
            std::env::var_os("FTPEACH_MOVE_TEST_VOLUME").expect("Set a second volume path");
        let id = uuid::Uuid::new_v4().to_string();
        let source_dir = std::env::temp_dir().join(format!("ftpeach-move-source-{id}"));
        let target_dir = PathBuf::from(destination_root).join(format!("ftpeach-move-target-{id}"));
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::create_dir(&target_dir).unwrap();
        let probe = source_dir.join("volume-probe");
        std::fs::write(&probe, b"probe").unwrap();
        let error = std::fs::rename(&probe, target_dir.join("volume-probe"))
            .expect_err("the fixture must use two genuinely different volumes");
        assert_eq!(error.raw_os_error(), Some(17));
        std::fs::remove_file(probe).unwrap();
        for overwrite in [false, true] {
            let source = source_dir.join("file.bin");
            let target = target_dir.join("file.bin");
            let data = vec![73; 3 * 1024 * 1024 + 19];
            std::fs::write(&source, &data).unwrap();
            if overwrite {
                std::fs::write(&target, b"old").unwrap();
                let refused = fs_rename_checked(
                    source.to_string_lossy().into(),
                    target.to_string_lossy().into(),
                    None,
                )
                .await;
                assert!(refused.is_err());
                assert_eq!(std::fs::read(&source).unwrap(), data);
                assert_eq!(std::fs::read(&target).unwrap(), b"old");
            }
            let result = fs_rename_checked(
                source.to_string_lossy().into(),
                target.to_string_lossy().into(),
                Some(overwrite),
            )
            .await;
            assert!(result.is_ok(), "{result:?}");
            assert!(!source.exists());
            assert_eq!(std::fs::read(&target).unwrap(), data);
            assert_eq!(std::fs::read_dir(&target_dir).unwrap().count(), 1);
            std::fs::remove_file(target).unwrap();
        }
        std::fs::remove_dir(source_dir).unwrap();
        std::fs::remove_dir(target_dir).unwrap();
    }
}
