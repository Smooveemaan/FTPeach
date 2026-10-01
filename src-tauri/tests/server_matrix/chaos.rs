//! Faulty links: one server per protocol behind Toxiproxy (profile `chaos`).
//! Each test starts from a clean proxy and adds its toxics through the API.

use crate::support::*;
use crate::targets::{Kind, Target};
use app_lib::ErrorCode;
use app_lib::protocol::{ProgressInfo, ProgressSink};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const API: &str = "http://127.0.0.1:8474";

/// The Toxiproxy proxies a target's traffic crosses: FTP has its passive data
/// ports behind the proxy as well as its control port.
fn proxies(kind: Kind) -> Vec<String> {
    match kind {
        Kind::Ftp => std::iter::once("vsftpd".to_string())
            .chain((31040..=31049).map(|port| format!("vsftpd_data_{port}")))
            .collect(),
        Kind::Sftp => vec!["openssh_chroot".into()],
        Kind::Webdav => vec!["apache_basic".into()],
    }
}

async fn post(path: &str, body: Value) {
    // Not through the system proxy: the API is on this machine.
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{API}{path}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap_or_else(|error| panic!("toxiproxy {path}: {error} (is the chaos profile up?)"));
    let status = response.status();
    assert!(
        status.is_success(),
        "toxiproxy {path}: {status} {}",
        response.text().await.unwrap_or_default()
    );
}

/// Removes every toxic and re-enables every proxy.
async fn reset() {
    post("/reset", json!({})).await;
}

async fn toxic(kind: Kind, name: &str, stream: &str, kind_of: &str, attributes: Value) {
    for proxy in proxies(kind) {
        post(
            &format!("/proxies/{proxy}/toxics"),
            json!({"name": name, "type": kind_of, "stream": stream, "attributes": attributes}),
        )
        .await;
    }
}

/// Disabling a proxy closes every connection through it.
async fn set_enabled(kind: Kind, enabled: bool) {
    for proxy in proxies(kind) {
        post(&format!("/proxies/{proxy}"), json!({"enabled": enabled})).await;
    }
}

fn payload(len: usize) -> Vec<u8> {
    (0..len as u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
        .collect()
}

/// Progress reports as (bytes, total), in order.
type Reports = Arc<Mutex<Vec<(u64, u64)>>>;

fn recording() -> (ProgressSink, Reports) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let progress: ProgressSink = Arc::new(move |info| {
        if let ProgressInfo::Progress { bytes, total } = info {
            sink.lock().unwrap().push((bytes, total));
        }
    });
    (progress, seen)
}

/// Stages a file with no toxics, so only the part under test is slowed.
async fn staged(target: &Target, len: usize) -> (Backend, Work, String, Vec<u8>) {
    reset().await;
    let mut backend = connect(target).await;
    let work = Work::new(target, &mut backend).await;
    let content = payload(len);
    let remote = work.path("chaos.bin");
    put(&mut backend, &work.local("staged.bin"), &remote, &content).await;
    (backend, work, remote, content)
}

/// Waits until the transfer has moved `bytes`, then cuts every connection.
async fn cut_after(kind: Kind, moved: &AtomicU64, bytes: u64) {
    while moved.load(Ordering::SeqCst) < bytes {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    set_enabled(kind, false).await;
}

/// Bytes in the `.ftpeach-*.part` partial a stopped download left in `dir`.
async fn partial_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0;
    let mut entries = tokio::fs::read_dir(dir).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".ftpeach-") && name.ends_with(".part") {
            total += entry.metadata().await.unwrap().len();
        }
    }
    total
}

/// 300 ms each way and 256 KB/s down: the download completes, progress only
/// grows and ends at the file size.
pub async fn c01_slow_link(target: Target) {
    let len = 1024 * 1024;
    let (mut backend, work, remote, content) = staged(&target, len).await;
    toxic(
        target.kind,
        "latency_down",
        "downstream",
        "latency",
        json!({"latency": 300}),
    )
    .await;
    toxic(
        target.kind,
        "latency_up",
        "upstream",
        "latency",
        json!({"latency": 300}),
    )
    .await;
    toxic(
        target.kind,
        "bandwidth",
        "downstream",
        "bandwidth",
        json!({"rate": 256}),
    )
    .await;

    let (progress, seen) = recording();
    let destination = work.local("slow.bin");
    let started = Instant::now();
    let result = backend
        .download(&remote, &destination, false, progress)
        .await;
    let elapsed = started.elapsed();
    reset().await;
    result.unwrap_or_else(|error| {
        panic!(
            "{}: slow download [{:?}]: {error:#}",
            target.id,
            code(&error)
        )
    });
    println!("{}: 1 MiB over the slow link in {elapsed:?}", target.id);

    // 1 MiB at 256 KB/s is four seconds: less means the toxic missed the data.
    assert!(
        elapsed >= Duration::from_secs(3),
        "{}: not throttled ({elapsed:?})",
        target.id
    );
    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.len() > 1,
        "{}: progress reported {} times",
        target.id,
        seen.len()
    );
    assert!(
        seen.windows(2).all(|pair| pair[0].0 <= pair[1].0),
        "{}: progress went backwards: {seen:?}",
        target.id
    );
    assert_eq!(
        seen.last().unwrap().0,
        len as u64,
        "{}: final progress",
        target.id
    );
    assert!(
        seen.iter().all(|&(_, total)| total == len as u64),
        "{}: total",
        target.id
    );
    assert!(
        tokio::fs::read(&destination).await.unwrap() == content,
        "{}: content",
        target.id
    );
    work.finish(&mut backend).await;
}

/// The link drops in the middle of a download: the error is `ConnectionLost`,
/// the partial file stays, and a new connection resumes it to the right bytes.
pub async fn c02_drop_mid_transfer(target: Target) {
    let len = 2 * 1024 * 1024;
    let (mut backend, work, remote, content) = staged(&target, len).await;
    // A version read in the second the file was written vouches for no
    // partial (see webdav::resume_version), so the resume would start over.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    toxic(
        target.kind,
        "bandwidth",
        "downstream",
        "bandwidth",
        json!({"rate": 512}),
    )
    .await;

    let moved = Arc::new(AtomicU64::new(0));
    let sink = moved.clone();
    let progress: ProgressSink = Arc::new(move |info| {
        if let ProgressInfo::Progress { bytes, .. } = info {
            sink.store(bytes, Ordering::SeqCst);
        }
    });
    let destination = work.local("dropped.bin");
    let (result, ()) = tokio::join!(
        backend.download(&remote, &destination, false, progress),
        cut_after(target.kind, &moved, 256 * 1024),
    );
    reset().await;
    let error = result.expect_err("a download over a dropped link must fail");
    assert_eq!(
        code(&error),
        ErrorCode::ConnectionLost,
        "{}: {error:#}",
        target.id
    );

    // The download writes a hidden sibling and renames it only when complete.
    assert!(
        !destination.exists(),
        "{}: incomplete file committed",
        target.id
    );
    let partial = partial_bytes(&work.local).await;
    println!(
        "{}: dropped after {partial} of {len} bytes: {error:#}",
        target.id
    );
    assert!(
        partial > 0 && partial < len as u64,
        "{}: partial file is {partial} bytes",
        target.id
    );

    let mut backend = connect(&target).await;
    assert!(
        resume(&mut backend, &remote, &destination).await == content,
        "{}: resumed content",
        target.id
    );
    work.finish(&mut backend).await;
}

/// The server stops answering (the link swallows every byte and never
/// closes): the next operation fails as `TimedOut`, and within a bound of the
/// configured 5 s timeout rather than hanging.
pub async fn c03_silent_server(target: Target) {
    reset().await;
    let mut backend = connect(&target).await;
    toxic(
        target.kind,
        "silence",
        "downstream",
        "timeout",
        json!({"timeout": 0}),
    )
    .await;
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        backend.list(&fixtures(&target, "sizes")),
    )
    .await;
    let elapsed = started.elapsed();
    reset().await;
    let error = result
        .unwrap_or_else(|_| panic!("{}: listing a silent server hung for 60 s", target.id))
        .err()
        .unwrap_or_else(|| panic!("{}: listing a silent server succeeded", target.id));
    println!(
        "{}: silent server failed in {elapsed:?}: {error:#}",
        target.id
    );
    assert_eq!(
        code(&error),
        ErrorCode::TimedOut,
        "{}: {error:#}",
        target.id
    );
    assert!(
        elapsed < Duration::from_secs(15),
        "{}: took {elapsed:?}",
        target.id
    );
}

/// The link drops while a 10 000-entry listing streams in: the listing fails
/// instead of returning the entries that made it.
pub async fn c04_drop_during_listing(target: Target) {
    reset().await;
    let mut backend = connect(&target).await;
    // Slow enough that the listing is still arriving when the link drops.
    toxic(
        target.kind,
        "bandwidth",
        "downstream",
        "bandwidth",
        json!({"rate": 32}),
    )
    .await;
    let many = fixtures(&target, "many");
    let (result, ()) = tokio::join!(backend.list(&many), async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        set_enabled(target.kind, false).await;
    });
    reset().await;
    match result {
        Ok(entries) => panic!(
            "{}: a dropped listing returned {} entries as if complete",
            target.id,
            entries.len()
        ),
        Err(error) => {
            println!("{}: dropped listing: {error:#}", target.id);
            assert_eq!(
                code(&error),
                ErrorCode::ConnectionLost,
                "{}: {error:#}",
                target.id
            );
        }
    }
}
