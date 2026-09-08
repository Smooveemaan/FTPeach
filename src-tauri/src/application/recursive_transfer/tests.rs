use super::*;
fn fixture() -> (std::path::PathBuf, Intent) {
    let root = std::env::temp_dir().join(format!("ftpeach-recursive-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("source")).unwrap();
    let intent = Intent {
        id: uuid::Uuid::new_v4().to_string(),
        source: Endpoint::Local {
            path: root.join("source").to_string_lossy().into_owned(),
        },
        target: Endpoint::Local {
            path: root.join("target").to_string_lossy().into_owned(),
        },
        moving: true,
        overwrite: false,
        skip_existing: false,
    };
    (root, intent)
}

#[tokio::test]
async fn skip_merges_missing_files_and_retains_move_source() {
    for moving in [false, true] {
        let (root, mut intent) = fixture();
        intent.moving = moving;
        intent.skip_existing = true;
        std::fs::create_dir_all(root.join("target/nested")).unwrap();
        std::fs::create_dir_all(root.join("source/nested")).unwrap();
        std::fs::write(root.join("source/nested/old"), b"source").unwrap();
        std::fs::write(root.join("source/nested/new"), b"new").unwrap();
        std::fs::write(root.join("target/nested/old"), b"old").unwrap();
        let report = run(&Sessions::default(), None, intent).await;
        assert_eq!(report.ok, !moving);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.completed, 1);
        assert_eq!(
            std::fs::read(root.join("target/nested/old")).unwrap(),
            b"old"
        );
        assert_eq!(
            std::fs::read(root.join("target/nested/new")).unwrap(),
            b"new"
        );
        assert!(root.join("source/nested/old").is_file());
        assert!(root.join("source/nested/new").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn empty_directories_move_only_after_creation() {
    let (root, intent) = fixture();
    std::fs::create_dir(root.join("source/empty")).unwrap();
    let report = run(&Sessions::default(), None, intent).await;
    assert!(report.ok, "{:?}", report.errors);
    assert_eq!(report.outcome, "complete");
    assert!(root.join("target/empty").is_dir());
    assert!(!root.join("source").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn partial_copy_and_mkdir_failure_never_delete_source() {
    for directory_failure in [false, true] {
        let (root, intent) = fixture();
        std::fs::write(root.join("source/a"), b"source").unwrap();
        std::fs::write(root.join("source/b"), b"new").unwrap();
        if directory_failure {
            std::fs::write(root.join("target"), b"old").unwrap();
        } else {
            std::fs::create_dir(root.join("target")).unwrap();
            std::fs::write(root.join("target/a"), b"old").unwrap();
        }
        let report = run(&Sessions::default(), None, intent).await;
        assert!(!report.ok);
        assert_eq!(
            report.outcome,
            if directory_failure {
                "failed"
            } else {
                "partial"
            }
        );
        assert_eq!(std::fs::read(root.join("source/a")).unwrap(), b"source");
        assert_eq!(
            std::fs::read(if directory_failure {
                root.join("target")
            } else {
                root.join("target/a")
            })
            .unwrap(),
            b"old"
        );
        assert!(root.join("source/b").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn child_destination_is_rejected_before_writes() {
    let (root, mut intent) = fixture();
    intent.target = Endpoint::Local {
        path: root.join("source/child").to_string_lossy().into_owned(),
    };
    let report = run(&Sessions::default(), None, intent).await;
    assert!(!report.ok);
    assert!(!root.join("source/child").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn cancellation_interrupts_directory_scan() {
    let (root, intent) = fixture();
    for i in 0..1000 {
        std::fs::write(root.join("source").join(i.to_string()), []).unwrap();
    }
    let token = CancellationToken::new();
    let cancel = token.clone();
    let sessions = Sessions::default();
    let scanning = scan(&sessions, &intent.source, &token);
    let cancelling = async {
        tokio::task::yield_now().await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(scanning, cancelling);
    assert_eq!(
        CommandError::from_anyhow(&result.err().unwrap()).code,
        ErrorCode::Cancelled
    );
    assert!(!root.join("target").exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn cancelled_scan_never_reads_the_source() {
    let token = CancellationToken::new();
    token.cancel();
    let error = scan(
        &Sessions::default(),
        &Endpoint::Local {
            path: "missing".into(),
        },
        &token,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(CommandError::from_anyhow(&error).code, ErrorCode::Cancelled);
}

#[tokio::test]
async fn cancellation_before_ipc_start_and_depth_limit_preserve_source() {
    let (root, intent) = fixture();
    cancel(&intent.id);
    let report = run(&Sessions::default(), None, intent).await;
    assert_eq!(report.errors[0].code, ErrorCode::Cancelled);
    assert!(root.join("source").exists());
    assert!(!root.join("target").exists());
    std::fs::remove_dir_all(root).unwrap();
    let (root, intent) = fixture();
    let mut directory = root.join("source");
    for _ in 0..41 {
        directory.push("d");
        std::fs::create_dir(&directory).unwrap();
    }
    let report = run(&Sessions::default(), None, intent).await;
    assert!(!report.ok);
    assert!(directory.exists());
    assert!(!root.join("target").exists());
    std::fs::remove_dir_all(root).unwrap();
}
