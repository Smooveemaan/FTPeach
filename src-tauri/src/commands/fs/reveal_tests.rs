use super::*;
use std::os::unix::fs::PermissionsExt;
use tauri::Manager;

#[test]
fn reveal_falls_back_to_the_containing_folder() {
    check_reveal(true, "reveal_falls_back_to_the_containing_folder");
}

#[test]
fn reveal_reports_an_unavailable_file_manager() {
    check_reveal(false, "reveal_reports_an_unavailable_file_manager");
}

fn check_reveal(launcher_available: bool, test_name: &str) {
    const CHILD_ROOT: &str = "FTPEACH_REVEAL_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let file = root
            .join("folder with spaces # ' quote")
            .join("selected.txt");
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_opener::init())
            .manage(crate::local_fs::local_open::ApprovedLocalPaths::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.state::<crate::local_fs::local_open::ApprovedLocalPaths>()
            .approve_from_listing(&file);
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(open_validated_path(
                app.handle().clone(),
                app.state(),
                file.to_string_lossy().into_owned(),
                crate::local_fs::local_open::OpenKind::Reveal,
            ));
        assert_eq!(result.is_ok(), launcher_available, "{result:?}");
        if let Err(error) = result {
            assert!(!error.message.is_empty());
        }
        assert_eq!(std::fs::read(&file).unwrap(), b"unchanged");
        return;
    }

    // Isolate PATH and D-Bus from parallel tests and the user's desktop.
    let root = std::env::temp_dir().join(format!("ftpeach-reveal-{}", uuid::Uuid::new_v4()));
    let bin = root.join("bin");
    let parent = root.join("folder with spaces # ' quote");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir(&parent).unwrap();
    std::fs::write(parent.join("selected.txt"), b"unchanged").unwrap();
    if launcher_available {
        let launcher = bin.join("xdg-open");
        std::fs::write(
            &launcher,
            "#!/bin/sh\nprintf '%s' \"$1\" > \"$FTPEACH_REVEAL_TEST_ROOT/opened\"\n",
        )
        .unwrap();
        std::fs::set_permissions(launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("commands::fs::reveal_tests::{test_name}"),
            "--nocapture",
        ])
        .env(CHILD_ROOT, &root)
        .env("PATH", &bin)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}/absent-bus", root.display()),
        )
        .env_remove("FTPEACH_E2E_CDP_PORT")
        .env_remove("FTPEACH_E2E_CONTROL_PORT")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    if launcher_available {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::fs::read_to_string(root.join("opened")).ok().as_deref()
            != Some(parent.to_str().unwrap())
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            std::fs::read_to_string(root.join("opened")).unwrap(),
            parent.to_string_lossy()
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}
