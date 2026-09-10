//! Round trips and cancellation against disposable FTP/FTPS/SFTP/WebDAV servers.
//! Start tests/docker/docker-compose.yml before running with test-utils and --ignored.
//! Without that feature this target contains no tests and proves no compatibility.
#![cfg(feature = "test-utils")]

use app_lib::protocol::config::ConnectionConfig;
use app_lib::protocol::ftp::FtpBackend;
use app_lib::protocol::sftp::SftpBackend;
use app_lib::protocol::webdav::WebDavBackend;
use app_lib::protocol::{EntryInfo, ProgressInfo, ProgressSink, ProtocolBackend};
use app_lib::store::Store;
use app_lib::transfer_pool::{BackendFactory, BoxBackend, PoolSize, TaskFn, TransferPool};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn noop_progress() -> ProgressSink {
    Arc::new(|_info| {})
}

fn ensure_crypto_provider() {
    // Same one-time install lib.rs's run() does at real app startup — this
    // binary never calls run(), so FTPS's rustls handshake has no provider
    // installed unless a test does it first.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

async fn round_trip(mut backend: impl ProtocolBackend, config: &ConnectionConfig, dir: &str) {
    backend.connect(config).await.expect("connect");
    assert!(backend.is_connected());

    backend.mkdir(dir).await.expect("mkdir");

    let file_path = format!("{dir}/hello.txt");
    let content = b"FTPeach docker integration test payload\n".to_vec();
    let local_upload = std::env::temp_dir().join(format!(
        "ftpeach-docker-test-upload-{}.txt",
        dir.replace('/', "-")
    ));
    tokio::fs::write(&local_upload, &content)
        .await
        .expect("write local upload fixture");

    backend
        .upload(&local_upload, &file_path, false, noop_progress())
        .await
        .expect("upload");
    let _ = tokio::fs::remove_file(&local_upload).await;

    let entries = backend.list(dir).await.expect("list");
    let uploaded = entries
        .iter()
        .find(|e: &&EntryInfo| e.name == "hello.txt")
        .unwrap_or_else(|| {
            panic!(
                "hello.txt missing from listing: {:?}",
                entry_names(&entries)
            )
        });
    assert!(!uploaded.is_directory);
    assert_eq!(uploaded.size, content.len() as u64);

    let local_download = std::env::temp_dir().join(format!(
        "ftpeach-docker-test-download-{}.txt",
        dir.replace('/', "-")
    ));
    let _ = tokio::fs::remove_file(&local_download).await;
    backend
        .download(&file_path, &local_download, false, noop_progress())
        .await
        .expect("download");
    let downloaded = tokio::fs::read(&local_download)
        .await
        .expect("read downloaded file");
    assert_eq!(downloaded, content);
    let _ = tokio::fs::remove_file(&local_download).await;

    let renamed_path = format!("{dir}/renamed.txt");
    backend
        .rename(&file_path, &renamed_path)
        .await
        .expect("rename");
    let entries = backend.list(dir).await.expect("list after rename");
    assert!(
        entries.iter().any(|e| e.name == "renamed.txt"),
        "renamed.txt missing from listing: {:?}",
        entry_names(&entries)
    );

    backend
        .remove(&renamed_path, false)
        .await
        .expect("remove file");
    backend.remove(dir, true).await.expect("remove dir");

    backend.disconnect().await.expect("disconnect");
    assert!(!backend.is_connected());
}

async fn resume_round_trip(
    mut backend: impl ProtocolBackend,
    config: &ConnectionConfig,
    dir: &str,
    resume_upload: bool,
) {
    let dir = format!("{dir}-{}", uuid::Uuid::new_v4());
    let dir = dir.as_str();
    const PARTIAL_SUFFIX: &str = ".ftpeach-part";
    let content: Vec<u8> = (0..196_731).map(|index| (index % 251) as u8).collect();
    let split = 65_537;
    let root = std::env::temp_dir().join(format!("ftpeach-docker-resume-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root)
        .await
        .expect("create resume fixture directory");
    let full_source = root.join("full.bin");
    let partial_source = root.join("partial.bin");
    let destination = root.join("download.bin");
    let partial_destination = root.join(format!("download.bin{PARTIAL_SUFFIX}"));
    tokio::fs::write(&full_source, &content)
        .await
        .expect("write full resume fixture");
    tokio::fs::write(&partial_source, &content[..split])
        .await
        .expect("write partial upload fixture");

    backend.connect(config).await.expect("connect for resume");
    backend.mkdir(dir).await.expect("mkdir for resume");
    let remote_path = format!("{dir}/resume.bin");
    if resume_upload {
        backend
            .upload(&partial_source, &remote_path, false, noop_progress())
            .await
            .expect("seed partial remote upload");

        // Before appending, production proves the staged bytes still match the
        // source by reading them back. On FTP that read is REST + RETR over a
        // data connection, so the returned bytes are only half of what is being
        // tested: an unfinalised data transfer leaves the control channel one
        // response out of step, and that damage surfaces on the *next* command
        // — here, the resumed upload immediately below.
        let window = 4_096usize;
        let tail_at = (split - window) as u64;
        let staged_tail = backend
            .read_range(&remote_path, tail_at, window)
            .await
            .expect("read the staged tail");
        assert_eq!(
            staged_tail,
            content[tail_at as usize..split],
            "the staged tail must match the bytes the source holds there"
        );
        // Offset zero takes the branch that sends no REST at all.
        let staged_whole = backend
            .read_range(&remote_path, 0, split)
            .await
            .expect("read the whole staged file");
        assert_eq!(staged_whole, content[..split]);

        backend
            .upload(&full_source, &remote_path, true, noop_progress())
            .await
            .expect("resume remote upload");
    } else {
        backend
            .upload(&full_source, &remote_path, false, noop_progress())
            .await
            .expect("upload download fixture");
    }

    let foreign_partial = vec![0xff; split];
    tokio::fs::write(&partial_destination, &foreign_partial)
        .await
        .expect("seed partial local download");
    backend
        .download(&remote_path, &destination, true, noop_progress())
        .await
        .expect("resume download");
    assert_eq!(
        tokio::fs::read(&destination)
            .await
            .expect("read resumed download"),
        content
    );
    assert_eq!(
        tokio::fs::read(&partial_destination)
            .await
            .expect("read foreign partial"),
        foreign_partial,
        "legacy partial belongs to no verified operation and must remain untouched"
    );

    backend
        .remove(&remote_path, false)
        .await
        .expect("remove resume fixture");
    backend.remove(dir, true).await.expect("remove resume dir");
    backend.disconnect().await.expect("disconnect after resume");
    let _ = tokio::fs::remove_dir_all(root).await;
}

fn entry_names(entries: &[EntryInfo]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn ftp_round_trip_against_docker_server() {
    let config = json!({
        "protocol": "ftp",
        "host": "127.0.0.1",
        "port": 2131,
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    tokio::time::timeout(
        Duration::from_secs(30),
        round_trip(FtpBackend::new(), &config, "/roundtrip-ftp"),
    )
    .await
    .expect(
        "test timed out — is `docker compose -f tests/docker/docker-compose.yml up -d` running?",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn ftps_round_trip_against_docker_server() {
    ensure_crypto_provider();
    let config = json!({
        "protocol": "ftps",
        "host": "127.0.0.1",
        "port": 2131,
        "user": "testuser",
        "password": "testpass",
        // pure-ftpd's ADDED_FLAGS=--tls=1 cert is self-signed.
        "allowInvalidCert": true,
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    tokio::time::timeout(
        Duration::from_secs(30),
        round_trip(FtpBackend::new(), &config, "/roundtrip-ftps"),
    )
    .await
    .expect(
        "test timed out — is `docker compose -f tests/docker/docker-compose.yml up -d` running?",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn ftps_rejects_untrusted_docker_certificate() {
    ensure_crypto_provider();
    let config = json!({
        "protocol": "ftps",
        "host": "127.0.0.1",
        "port": 2131,
        "user": "testuser",
        "password": "testpass",
        "allowInvalidCert": false,
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    let mut backend = FtpBackend::new();
    let error = tokio::time::timeout(Duration::from_secs(15), backend.connect(&config))
        .await
        .expect("strict FTPS connection timed out")
        .expect_err("the disposable server's self-signed certificate must be rejected");
    assert!(
        format!("{error:#}").contains("TLS handshake failed"),
        "unexpected strict FTPS error: {error:#}"
    );
    assert!(!backend.is_connected());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn ftp_resume_against_docker_server() {
    let config = json!({
        "protocol": "ftp",
        "host": "127.0.0.1",
        "port": 2131,
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    tokio::time::timeout(
        Duration::from_secs(30),
        resume_round_trip(FtpBackend::new(), &config, "/resume-ftp", true),
    )
    .await
    .expect("FTP resume test timed out");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn sftp_round_trip_against_docker_server() {
    let config = json!({
        "protocol": "sftp",
        "host": "127.0.0.1",
        "port": 2222,
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    // atmoz/sftp chroots testuser to a root-owned home dir with only
    // /upload writable underneath (see docker-compose.yml's command).
    let store_dir = std::env::temp_dir().join(format!(
        "ftpeach-docker-sftp-known-hosts-{}",
        std::process::id()
    ));
    let store = Store::new_at(store_dir.clone());

    tokio::time::timeout(
        Duration::from_secs(30),
        round_trip(
            SftpBackend::new(Arc::new(store)),
            &config,
            "/upload/roundtrip-sftp",
        ),
    )
    .await
    .expect(
        "test timed out — is `docker compose -f tests/docker/docker-compose.yml up -d` running?",
    );

    let _ = tokio::fs::remove_dir_all(&store_dir).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn sftp_tofu_pins_matches_and_rejects_changed_fingerprint() {
    let config = json!({
        "protocol": "sftp",
        "host": "127.0.0.1",
        "port": 2222,
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");
    let store_dir =
        std::env::temp_dir().join(format!("ftpeach-docker-sftp-tofu-{}", uuid::Uuid::new_v4()));
    let store = Store::new_at(store_dir.clone());

    let mut first = SftpBackend::new(Arc::new(store.clone()));
    first
        .connect(&config)
        .await
        .expect("first sighting should pin and connect");
    first.disconnect().await.expect("first disconnect");

    let known_hosts_path = store_dir.join("known_hosts.json");
    let mut pinned: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&known_hosts_path)
            .await
            .expect("TOFU should persist known_hosts.json"),
    )
    .expect("known_hosts.json should be valid JSON");
    assert!(
        pinned
            .pointer("/data/127.0.0.1:2222")
            .and_then(|value| value.as_str())
            .is_some(),
        "first sighting should persist the server fingerprint"
    );

    let mut repeat = SftpBackend::new(Arc::new(store.clone()));
    repeat
        .connect(&config)
        .await
        .expect("unchanged host key should match the pin");
    repeat.disconnect().await.expect("repeat disconnect");

    pinned["data"]["127.0.0.1:2222"] =
        serde_json::Value::String("intentionally-wrong-fingerprint".into());
    tokio::fs::write(
        &known_hosts_path,
        serde_json::to_vec_pretty(&pinned).unwrap(),
    )
    .await
    .expect("replace the pinned fingerprint fixture");
    let mut changed = SftpBackend::new(Arc::new(store));
    let error = changed
        .connect(&config)
        .await
        .expect_err("a changed host key must be rejected");
    let message = format!("{error:#}");
    assert!(
        message.contains("host key") || message.contains("fingerprint"),
        "unexpected TOFU mismatch error: {message}"
    );
    assert!(!changed.is_connected());

    let _ = tokio::fs::remove_dir_all(&store_dir).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn sftp_resume_against_docker_server() {
    let config = json!({
        "protocol": "sftp",
        "host": "127.0.0.1",
        "port": 2222,
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");
    let store_dir = std::env::temp_dir().join(format!(
        "ftpeach-docker-sftp-resume-{}",
        uuid::Uuid::new_v4()
    ));

    tokio::time::timeout(
        Duration::from_secs(30),
        resume_round_trip(
            SftpBackend::new(Arc::new(Store::new_at(store_dir.clone()))),
            &config,
            "/upload/resume-sftp",
            true,
        ),
    )
    .await
    .expect("SFTP resume test timed out");
    let _ = tokio::fs::remove_dir_all(store_dir).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn webdav_round_trip_against_docker_server() {
    let config = json!({
        "protocol": "webdav",
        "webdavUrl": "http://127.0.0.1:6065",
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    tokio::time::timeout(
        Duration::from_secs(30),
        round_trip(WebDavBackend::new(), &config, "/roundtrip-webdav"),
    )
    .await
    .expect("test timed out; are the Docker test servers running?");
}

async fn webdav_tls_round_trip(port: u16, protocol: &str) {
    let ca_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/docker/generated-tls/ca.pem");
    assert!(
        ca_path.is_file(),
        "TLS fixture CA was not generated by Docker Compose"
    );
    let config = json!({
        "protocol": "webdav",
        "webdavUrl": format!("https://localhost:{port}"),
        "user": "testuser",
        "password": "testpass",
        "allowInvalidCert": false,
        "caCertPath": ca_path.to_string_lossy(),
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid TLS WebDAV config");

    tokio::time::timeout(
        Duration::from_secs(30),
        round_trip(
            WebDavBackend::new(),
            &config,
            &format!("/roundtrip-webdav-{protocol}"),
        ),
    )
    .await
    .unwrap_or_else(|_| panic!("{protocol} WebDAV round trip timed out"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn webdav_custom_ca_over_tls12_against_docker_server() {
    ensure_crypto_provider();
    webdav_tls_round_trip(6443, "tls12").await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn webdav_custom_ca_over_tls13_against_docker_server() {
    ensure_crypto_provider();
    webdav_tls_round_trip(6444, "tls13").await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn webdav_resume_download_against_docker_server() {
    let config = json!({
        "protocol": "webdav",
        "webdavUrl": "http://127.0.0.1:6065",
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");

    tokio::time::timeout(
        Duration::from_secs(30),
        resume_round_trip(WebDavBackend::new(), &config, "/resume-webdav", false),
    )
    .await
    .expect("WebDAV resume test timed out");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn webdav_cancel_preserves_resumable_partial_against_docker_server() {
    let config = json!({
        "protocol": "webdav",
        "webdavUrl": "http://127.0.0.1:6065",
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");
    let root = std::env::temp_dir().join(format!("ftpeach-docker-cancel-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root)
        .await
        .expect("create cancel fixture directory");
    let source = root.join("source.bin");
    let destination = root.join("cancelled.bin");

    let content = vec![0x5a; 32 * 1024 * 1024];
    tokio::fs::write(&source, &content)
        .await
        .expect("write cancel fixture");

    let mut setup = WebDavBackend::new();
    setup.connect(&config).await.expect("connect setup backend");
    setup
        .upload(&source, "/cancel.bin", false, noop_progress())
        .await
        .expect("upload cancel fixture");
    setup.disconnect().await.expect("disconnect setup backend");

    let factory_config = config.clone();
    let factory: BackendFactory = Arc::new(move || {
        let config = factory_config.clone();
        Box::pin(async move {
            let mut backend = WebDavBackend::new();
            backend.connect(&config).await?;
            Ok(Box::new(backend) as BoxBackend)
        })
    });
    let pool = TransferPool::new(factory, PoolSize::Fixed(1));
    let first_progress = Arc::new(tokio::sync::Notify::new());
    let notified = Arc::new(AtomicBool::new(false));
    let progress: ProgressSink = {
        let first_progress = first_progress.clone();
        let notified = notified.clone();
        Arc::new(move |info| {
            if matches!(info, ProgressInfo::Progress { bytes, .. } if bytes > 0)
                && !notified.swap(true, Ordering::SeqCst)
            {
                first_progress.notify_one();
            }
        })
    };
    let task_destination = destination.clone();
    let task: TaskFn = Box::new(move |backend| {
        Box::pin(async move {
            backend
                .download("/cancel.bin", &task_destination, false, progress)
                .await
        })
    });
    let run_pool = pool.clone();
    let run = tokio::spawn(async move { run_pool.run("cancel-download".into(), task).await });

    tokio::time::timeout(Duration::from_secs(10), first_progress.notified())
        .await
        .expect("real download should report progress before cancellation");
    assert!(pool.cancel("cancel-download"));
    let error = run
        .await
        .expect("cancel task should join")
        .expect_err("cancelled transfer must fail");
    assert!(format!("{error:#}").contains("Canceled by user"));
    assert!(tokio::fs::metadata(&destination).await.is_err());
    let mut artifacts = tokio::fs::read_dir(&root)
        .await
        .expect("read isolated artifacts");
    let mut partials = Vec::new();
    while let Some(entry) = artifacts.next_entry().await.expect("read artifact entry") {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".ftpeach-") && name.ends_with(".part") {
            partials.push(entry.path());
        }
    }
    assert_eq!(
        partials.len(),
        1,
        "cancel retains exactly its owned partial"
    );
    let partial = &partials[0];
    let partial_size = tokio::fs::metadata(partial)
        .await
        .expect("cancelled download should retain its partial")
        .len();
    assert!(partial_size > 0 && partial_size < content.len() as u64);
    pool.destroy().await;

    let mut resume = WebDavBackend::new();
    let resumed_range = Arc::new(AtomicBool::new(false));
    let observed_range = resumed_range.clone();
    resume.set_log_enabled(true);
    resume.set_log_sink(Some(Arc::new(move |text, _| {
        if let app_lib::protocol::LogText::Raw(text) = text
            && text.contains(&format!("Range: bytes={partial_size}-"))
        {
            observed_range.store(true, Ordering::SeqCst);
        }
    })));
    resume
        .connect(&config)
        .await
        .expect("connect resume backend");
    resume
        .download("/cancel.bin", &destination, true, noop_progress())
        .await
        .expect("resume cancelled download");
    assert!(
        resumed_range.load(Ordering::SeqCst),
        "resume requests only the missing suffix"
    );
    assert_eq!(
        tokio::fs::read(&destination)
            .await
            .expect("read resumed cancellation fixture"),
        content
    );
    assert!(
        tokio::fs::metadata(partial).await.is_err(),
        "successful resume commits its owned artifact"
    );

    resume
        .remove("/cancel.bin", false)
        .await
        .expect("remove remote cancel fixture");
    resume
        .disconnect()
        .await
        .expect("disconnect resume backend");
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn sftp_cancel_preserves_resumable_partial_against_docker_server() {
    let config = json!({
        "protocol": "sftp",
        "host": "127.0.0.1",
        "port": 2222,
        "user": "testuser",
        "password": "testpass",
    })
    .as_object()
    .unwrap()
    .clone();
    let config = ConnectionConfig::from_json_map(&config).expect("valid config");
    let store_dir = std::env::temp_dir().join(format!(
        "ftpeach-docker-sftp-cancel-store-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(Store::new_at(store_dir.clone()));
    let root = std::env::temp_dir().join(format!(
        "ftpeach-docker-sftp-cancel-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&root)
        .await
        .expect("create cancel fixture directory");
    let source = root.join("source.bin");
    let destination = root.join("cancelled.bin");
    let content: Vec<u8> = (0..32 * 1024 * 1024)
        .map(|index| (index % 251) as u8)
        .collect();
    tokio::fs::write(&source, &content)
        .await
        .expect("write cancel fixture");
    let remote = format!("/upload/cancel-sftp-{}.bin", uuid::Uuid::new_v4());

    let mut setup = SftpBackend::new(store.clone());
    setup.connect(&config).await.expect("connect setup backend");
    setup
        .upload(&source, &remote, false, noop_progress())
        .await
        .expect("upload cancel fixture");
    setup.disconnect().await.expect("disconnect setup backend");

    let factory_config = config.clone();
    let factory_store = store.clone();
    let factory: BackendFactory = Arc::new(move || {
        let config = factory_config.clone();
        let store = factory_store.clone();
        Box::pin(async move {
            let mut backend = SftpBackend::new(store);
            backend.connect(&config).await?;
            Ok(Box::new(backend) as BoxBackend)
        })
    });
    let pool = TransferPool::new(factory, PoolSize::Fixed(1));
    // Well into the file, so a restart from zero cannot pass for a resume.
    const CANCEL_AFTER: u64 = 4 * 1024 * 1024;
    let far_enough = Arc::new(tokio::sync::Notify::new());
    let notified = Arc::new(AtomicBool::new(false));
    let progress: ProgressSink = {
        let far_enough = far_enough.clone();
        let notified = notified.clone();
        Arc::new(move |info| {
            if matches!(info, ProgressInfo::Progress { bytes, .. } if bytes >= CANCEL_AFTER)
                && !notified.swap(true, Ordering::SeqCst)
            {
                far_enough.notify_one();
            }
        })
    };
    let task_destination = destination.clone();
    let task_remote = remote.clone();
    let task: TaskFn = Box::new(move |backend| {
        Box::pin(async move {
            backend
                .download(&task_remote, &task_destination, false, progress)
                .await
        })
    });
    let run_pool = pool.clone();
    let run = tokio::spawn(async move { run_pool.run("sftp-cancel-download".into(), task).await });

    tokio::time::timeout(Duration::from_secs(20), far_enough.notified())
        .await
        .expect("real download should get well under way before cancellation");
    assert!(pool.cancel("sftp-cancel-download"));
    let error = run
        .await
        .expect("cancel task should join")
        .expect_err("cancelled transfer must fail");
    assert!(format!("{error:#}").contains("Canceled by user"));
    assert!(tokio::fs::metadata(&destination).await.is_err());
    let mut artifacts = tokio::fs::read_dir(&root)
        .await
        .expect("read isolated artifacts");
    let mut partials = Vec::new();
    while let Some(entry) = artifacts.next_entry().await.expect("read artifact entry") {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".ftpeach-") && name.ends_with(".part") {
            partials.push(entry.path());
        }
    }
    assert_eq!(
        partials.len(),
        1,
        "cancel retains exactly its owned partial"
    );
    let partial = &partials[0];
    let partial_size = tokio::fs::metadata(partial)
        .await
        .expect("cancelled download should retain its partial")
        .len();
    assert!(partial_size > 0 && partial_size < content.len() as u64);
    pool.destroy().await;

    let first_progress = Arc::new(std::sync::Mutex::new(None::<u64>));
    let observed = first_progress.clone();
    let resumed_progress: ProgressSink = Arc::new(move |info| {
        if let ProgressInfo::Progress { bytes, .. } = info {
            observed.lock().unwrap().get_or_insert(bytes);
        }
    });
    let mut resume = SftpBackend::new(store);
    resume
        .connect(&config)
        .await
        .expect("connect resume backend");
    resume
        .download(&remote, &destination, true, resumed_progress)
        .await
        .expect("resume cancelled download");
    let first = first_progress
        .lock()
        .unwrap()
        .expect("resumed download reports progress");
    assert!(
        first > partial_size,
        "resume must carry on from the {partial_size}-byte partial, not restart (first progress at {first})"
    );
    assert!(
        tokio::fs::read(&destination)
            .await
            .expect("read resumed cancellation fixture")
            == content,
        "resumed download must match the source"
    );
    assert!(
        tokio::fs::metadata(partial).await.is_err(),
        "successful resume commits its owned artifact"
    );

    resume
        .remove(&remote, false)
        .await
        .expect("remove remote cancel fixture");
    resume
        .disconnect()
        .await
        .expect("disconnect resume backend");
    let _ = tokio::fs::remove_dir_all(root).await;
    let _ = tokio::fs::remove_dir_all(store_dir).await;
}
