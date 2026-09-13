//! Disposable local enumeration comparison. Run sequentially without test load.
use std::{path::Path, time::Instant};
#[allow(dead_code)]
#[path = "../src/local_fs/fs_listing.rs"]
mod fs_listing;

async fn enumerate(root: &Path, mode: &str) -> std::io::Result<usize> {
    if mode == "blocking" {
        let root = root.to_owned();
        return tokio::task::spawn_blocking(move || {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                entries.push((entry.file_name(), entry.metadata()?));
            }
            Ok(entries.len())
        })
        .await
        .map_err(std::io::Error::other)?;
    }
    let mut directory = tokio::fs::read_dir(root).await?;
    let mut entries = Vec::new();
    let mut pending = tokio::task::JoinSet::new();
    while let Some(entry) = directory.next_entry().await? {
        if mode == "tokio" {
            entries.push((entry.file_name(), entry.metadata().await?));
        } else {
            pending.spawn(async move {
                Ok::<_, std::io::Error>((entry.file_name(), entry.metadata().await?))
            });
            if pending.len() == 8 {
                entries.push(
                    pending
                        .join_next()
                        .await
                        .unwrap()
                        .map_err(std::io::Error::other)??,
                );
            }
        }
    }
    while let Some(entry) = pending.join_next().await {
        entries.push(entry.map_err(std::io::Error::other)??);
    }
    Ok(entries.len())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args().nth(1).ok_or("Pass an output JSON path")?;
    let count = std::env::args()
        .nth(2)
        .map(|n| n.parse())
        .transpose()?
        .unwrap_or(100_001usize);
    let parent = std::env::args()
        .nth(3)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let root = parent.join(format!(
        "ftpeach-listing-benchmark-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root)?;
    for index in 0..count {
        std::fs::write(root.join(format!("file-{index:06}.txt")), b"fixture")?;
    }
    let mut results = Vec::new();
    for mode in ["tokio", "blocking", "bounded8"] {
        let mut samples = Vec::new();
        for sample in 0..8 {
            let start = Instant::now();
            assert_eq!(enumerate(&root, mode).await?, count);
            if sample >= 2 {
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        results.push(serde_json::json!({ "mode": mode, "samplesMs": samples }));
    }
    let production_start = Instant::now();
    let production =
        fs_listing::list_directory(&root, &tokio_util::sync::CancellationToken::new()).await;
    let production_ms = production_start.elapsed().as_secs_f64() * 1000.0;
    if count > 100_000 {
        assert!(
            production
                .as_ref()
                .err()
                .is_some_and(|error| error.to_string().contains("budget"))
        );
    } else {
        assert_eq!(production.as_ref().unwrap().len(), count);
    }
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
            .unwrap_or_default()
    };
    let artifact = serde_json::json!({
        "schemaVersion": 1, "fixtureVersion": 1, "entries": count,
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "logicalCpus": std::thread::available_parallelism()?.get(),
        "commit": git(&["rev-parse", "HEAD"]), "dirty": !git(&["status", "--porcelain"]).is_empty(),
        "fixtureParent": parent, "warmup": 2, "results": results,
        "productionMs": production_ms, "productionError": production.err().map(|error| error.to_string()),
        "scope": "Enumeration + metadata only; excludes IPC, approvals, formatting and UI. Six samples describe this run, not a p95 gate."
    });
    std::fs::write(output, serde_json::to_vec_pretty(&artifact)?)?;
    // Only the unique fixture directory this process created is removed.
    std::fs::remove_dir_all(root)?;
    Ok(())
}
