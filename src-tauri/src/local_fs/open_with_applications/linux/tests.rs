use super::*;

#[test]
fn desktop_associations_and_launch_preserve_file_arguments() {
    if let Some(root) = std::env::var_os("FTPEACH_OPEN_WITH_TEST_ROOT") {
        let root = std::path::PathBuf::from(root);
        let candidates = query_applications("notes.txt");
        assert_eq!(candidates[0].name, "Test Editor");
        assert!(candidates[0].is_default);
        assert_eq!(
            candidates
                .iter()
                .filter(|app| app.name == "Test Editor")
                .count(),
            1
        );
        assert!(
            candidates
                .iter()
                .any(|app| app.name == "Alternate Editor" && !app.is_default)
        );
        assert!(!candidates.iter().any(|app| app.name == "Hidden Editor"));
        let document = root.join("a b;'$ notes.txt");
        std::fs::write(&document, b"original").unwrap();
        let desktop = root.join("data/applications/editor.desktop");
        let approved = crate::local_fs::local_open::ApprovedLocalPaths::default();
        let desktop = approved.canonical_application(&desktop).unwrap();
        let chosen = gio::DesktopAppInfo::from_filename(&desktop).unwrap();
        let program = launch_chosen(chosen.upcast_ref(), &document, None).unwrap();
        assert_eq!(program, desktop);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let profile = root.join("profile");
            let store = crate::store::Store::new_at(profile.clone());
            assert!(!store.is_trusted_application(&program).await);
            store.trust_application(&program).await.unwrap();
            let reopened = crate::store::Store::new_at(profile);
            let default = candidates.iter().find(|app| app.is_default).unwrap();
            let default = approved
                .canonical_application(Path::new(&default.path))
                .unwrap();
            assert!(reopened.is_trusted_application(&default).await);
            let alternate = approved
                .canonical_application(&root.join("data/applications/alternate.desktop"))
                .unwrap();
            assert!(!reopened.is_trusted_application(&alternate).await);
        });
        let unavailable =
            gio::AppInfo::create_from_commandline("/bin/true", None, gio::AppInfoCreateFlags::NONE)
                .unwrap();
        assert!(launch_chosen(&unavailable, &document, None).is_err());
        let output = root.join("received");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !output.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "editor did not receive a file"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            std::fs::read_to_string(output).unwrap(),
            document.to_str().unwrap()
        );
        assert_eq!(std::fs::read(document).unwrap(), b"original");
        assert!(launch(&root.join("missing.desktop"), &root.join("notes.txt")).is_err());
        return;
    }
    let root = std::env::temp_dir().join(format!("ftpeach-gio-{}", uuid::Uuid::new_v4()));
    let apps = root.join("data/applications");
    std::fs::create_dir_all(&apps).unwrap();
    std::fs::create_dir(root.join("config")).unwrap();
    let script = root.join("editor.sh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'/received.tmp\nmv '{}'/received.tmp '{}'/received\n", root.display(), root.display(), root.display())).unwrap();
    for (id, name, hidden) in [
        ("editor", "Test Editor", false),
        ("alternate", "Alternate Editor", false),
        ("hidden", "Hidden Editor", true),
    ] {
        std::fs::write(apps.join(format!("{id}.desktop")), format!(
            "[Desktop Entry]\nType=Application\nName={name}\nExec=/bin/sh {} %f\nMimeType=text/plain;\nNoDisplay={hidden}\n", script.display()
        )).unwrap();
    }
    std::fs::write(
        apps.join("mimeinfo.cache"),
        "[MIME Cache]\ntext/plain=alternate.desktop;editor.desktop;hidden.desktop;\n",
    )
    .unwrap();
    std::fs::write(
        root.join("config/mimeapps.list"),
        "[Default Applications]\ntext/plain=editor.desktop;\n",
    )
    .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "local_fs::open_with_applications::linux::tests::desktop_associations_and_launch_preserve_file_arguments", "--nocapture"])
        .env("FTPEACH_OPEN_WITH_TEST_ROOT", &root)
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_DIRS", "/usr/share")
        .env("XDG_CONFIG_DIRS", root.join("config"))
        .output().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
