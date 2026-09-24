use super::*;
use crate::transfer::transfer_pool::PoolSize;
use std::sync::Arc;

fn offline_pool() -> TransferPool {
    TransferPool::new(
        Arc::new(|| Box::pin(async { anyhow::bail!("unexpected backend connection") })),
        PoolSize::Fixed(1),
    )
}

fn file(name: &str) -> DragOutFile {
    DragOutFile {
        name: name.into(),
        remote_path: format!("/source/{name}"),
        size: Some(42),
        is_directory: false,
    }
}

#[tokio::test]
async fn plain_files_preserve_order_paths_and_sizes_without_connecting() {
    let files = expand(&offline_pool(), vec![file("second.txt"), file("first.txt")])
        .await
        .unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].name, "second.txt");
    assert_eq!(files[0].remote_path, "/source/second.txt");
    assert_eq!(files[0].size, Some(42));
    assert!(!files[0].is_directory);
    assert_eq!(files[1].name, "first.txt");
    assert!(expand(&offline_pool(), vec![]).await.unwrap().is_empty());
}

#[tokio::test]
async fn unsafe_roots_fail_before_connecting_even_when_a_folder_is_present() {
    for name in [
        "../escape",
        "..",
        "",
        "bad\\child",
        "CON",
        "file:stream",
        "trailing.",
    ] {
        for is_directory in [false, true] {
            let mut root = file(name);
            root.is_directory = is_directory;
            let error = expand(&offline_pool(), vec![root]).await.err().expect(name);
            assert!(
                !error.to_string().contains("unexpected backend"),
                "{name}: {error}"
            );
        }
    }
}

#[tokio::test]
async fn duplicate_windows_names_are_rejected_for_file_only_drags() {
    for duplicate in ["report.txt", "REPORT.TXT"] {
        let error = expand(&offline_pool(), vec![file("report.txt"), file(duplicate)])
            .await
            .err()
            .expect("Explorer cannot represent two descriptors at the same path");
        assert!(error.to_string().contains("Duplicate Windows drag path"));
    }
}

#[tokio::test]
async fn descriptor_limits_count_utf16_units_before_any_network_access() {
    for name in ["a".repeat(260), "😀".repeat(130)] {
        for is_directory in [false, true] {
            let mut root = file(&name);
            root.is_directory = is_directory;
            let error = expand(&offline_pool(), vec![root]).await.err().unwrap();
            assert!(error.to_string().contains("descriptor limit"), "{error}");
        }
    }
    assert!(validate_relative_path(&"a".repeat(259)).is_ok());
    assert!(validate_relative_path(&format!("{}a", "😀".repeat(129))).is_ok());
}

#[tokio::test]
async fn file_only_drags_cannot_bypass_the_descriptor_count_limit() {
    let roots = (0..100_001)
        .map(|index| file(&format!("file{index}")))
        .collect();
    let error = expand(&offline_pool(), roots).await.err().unwrap();
    assert!(error.to_string().contains("too many entries"));
}
