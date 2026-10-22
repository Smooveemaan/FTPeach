use super::*;
use crate::application::memory_backend::{MemoryBackend as Backend, Remote};
use crate::transfer::transfer_pool::{BoxBackend, PoolSize, TransferPool};
use std::sync::Mutex;
use std::sync::atomic::Ordering::SeqCst;
use tokio::io::AsyncWriteExt;

fn backend(remote: &Arc<Remote>) -> BoxBackend {
    Box::new(Backend::over(remote.clone()))
}
fn fixture(stall: bool, reject_rename: bool) -> Arc<Remote> {
    let remote = Arc::new(Remote {
        stall,
        reject_rename,
        ..Remote::default()
    });
    remote
        .files
        .lock()
        .unwrap()
        .insert("/target".into(), b"old".to_vec());
    remote
}
/// A pool of one connection to `remote`.
fn one_connection_pool(remote: &Arc<Remote>) -> TransferPool {
    let remote = remote.clone();
    TransferPool::new(
        Arc::new(move || {
            let remote = remote.clone();
            Box::pin(async move { Ok(backend(&remote)) })
        }),
        PoolSize::Fixed(1),
    )
}
/// Sessions holding one, "test", browsing `remote` beside `pool`.
async fn sessions_with(remote: &Arc<Remote>, pool: &TransferPool) -> Sessions {
    let sessions = Sessions::default();
    *sessions.slot_for("test").lock().await = Some(crate::session::Session {
        browse_client: backend(remote),
        server: "test".into(),
        origin_base: String::new(),
        transfer_pool: pool.clone(),
        browse_timeout_ms: 1000,
    });
    sessions
}
/// A local file to upload, removed when dropped.
struct Source(PathBuf);
impl Source {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ftpeach-source-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"abc").unwrap();
        Self(path)
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn assert_old(remote: &Remote) {
    assert_eq!(remote.files.lock().unwrap()["/target"], b"old");
}

#[tokio::test]
async fn upload_commit_reports_done_only_after_successful_rename() {
    for reject in [false, true] {
        let remote = fixture(false, reject);
        let mut backend = backend(&remote);
        let partial = remote_partial_path("/target");
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_sink = events.clone();
        let staged_whole = std::sync::atomic::AtomicBool::new(false);
        let source = Source::new();
        let upload = upload_staged(
            &mut backend,
            &source.0,
            &partial,
            "/target",
            false,
            Arc::new(move |event| events_for_sink.lock().unwrap().push(event)),
            &staged_whole,
        );
        let result = crate::protocol::ALLOW_OVERWRITE.scope(true, upload).await;
        assert_eq!(result.is_err(), reject);
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, ProgressInfo::Done))
                .count(),
            usize::from(!reject)
        );
        if reject {
            assert_old(&remote);
        } else {
            assert_eq!(remote.files.lock().unwrap()["/target"], b"new");
        }
    }
}

#[tokio::test]
async fn a_source_saved_over_while_uploading_is_not_put_in_place_and_says_so() {
    for lengthen in [false, true] {
        let remote = Arc::new(Remote {
            rewrite_source: !lengthen,
            lengthen_source: lengthen,
            ..Remote::default()
        });
        remote
            .files
            .lock()
            .unwrap()
            .insert("/target".into(), b"old".to_vec());
        let mut backend = backend(&remote);
        let partial = remote_partial_path("/target");
        let source = Source::new();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_for_sink = done.clone();
        let staged_whole = std::sync::atomic::AtomicBool::new(false);
        let upload = upload_staged(
            &mut backend,
            &source.0,
            &partial,
            "/target",
            false,
            Arc::new(move |event| {
                if matches!(event, ProgressInfo::Done) {
                    done_for_sink.store(true, SeqCst);
                }
            }),
            &staged_whole,
        );
        let error = crate::protocol::ALLOW_OVERWRITE
            .scope(true, upload)
            .await
            .unwrap_err();
        // At its own length or not, the error names the source as what changed.
        assert_eq!(
            CommandError::from_anyhow(&error).code,
            ErrorCode::SourceChanged
        );
        assert!(!done.load(SeqCst));
        assert_old(&remote);
    }
}

#[tokio::test]
async fn queued_and_active_upload_cancellation_preserve_old_target_and_cleanup_only_staging() {
    for queued in [false, true] {
        let remote = fixture(true, false);
        let pool = one_connection_pool(&remote);
        let partial = remote_partial_path("/target");
        let task_partial = partial.clone();
        let source = Source::new();
        let task_source = source.0.clone();
        let task: TaskFn = Box::new(move |backend| {
            Box::pin(async move {
                upload_staged(
                    backend,
                    &task_source,
                    &task_partial,
                    "/target",
                    false,
                    Arc::new(|_| {}),
                    &std::sync::atomic::AtomicBool::new(false),
                )
                .await
            })
        });
        if queued {
            pool.cancel("upload");
        }
        let running_pool = pool.clone();
        let running = tokio::spawn(async move { running_pool.run("upload".into(), task).await });
        if !queued {
            tokio::time::timeout(std::time::Duration::from_secs(2), remote.writing.notified())
                .await
                .unwrap();
            pool.cancel("upload");
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), running)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_old(&remote);
        let sessions = sessions_with(&remote, &pool).await;
        cleanup_remote_partial(&sessions, "test", &partial).await;
        assert_eq!(remote.files.lock().unwrap().len(), 1);
        assert_old(&remote);
        pool.destroy().await;
    }
}

#[tokio::test]
async fn staging_cleanup_outlasts_a_server_still_holding_the_stopped_upload() {
    let remote = fixture(false, false);
    let partial = remote_partial_path("/target");
    remote
        .files
        .lock()
        .unwrap()
        .insert(partial.clone(), b"ne".to_vec());
    remote.held_removals.store(3, SeqCst);
    let pool = one_connection_pool(&remote);
    let sessions = sessions_with(&remote, &pool).await;

    cleanup_remote_partial(&sessions, "test", &partial).await;

    assert!(!remote.files.lock().unwrap().contains_key(&partial));
    assert_old(&remote);
    pool.destroy().await;
}

#[tokio::test]
async fn relay_does_not_commit_after_source_failure_or_disconnect() {
    for completion in [Some(true), Some(false), None] {
        let remote = fixture(false, false);
        let mut backend = backend(&remote);
        let partial = remote_partial_path("/target");
        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(b"new").await.unwrap();
        drop(writer);
        let (total_tx, total_rx) = tokio::sync::oneshot::channel();
        total_tx.send(Some(3)).unwrap();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        if let Some(done) = completion {
            done_tx.send(done).unwrap();
        } else {
            drop(done_tx);
        }
        let result = crate::protocol::ALLOW_OVERWRITE
            .scope(
                true,
                relay_staged(&mut backend, &partial, "/target", reader, total_rx, done_rx),
            )
            .await;
        assert_eq!(result.is_ok(), completion == Some(true));
        if completion != Some(true) {
            assert_old(&remote);
        }
    }
}

/// Another operation may not delete or replace a file while it is copied to
/// another server, as it may not with a folder; it may still read it.
#[tokio::test]
async fn a_file_copied_between_servers_keeps_writers_off_its_source() {
    use crate::local_fs::target_reservation::{Access, Reservation};
    let source = fixture(true, false);
    source
        .files
        .lock()
        .unwrap()
        .insert("/source".into(), b"abc".to_vec());
    let target = fixture(false, false);
    let (source_pool, target_pool) = (one_connection_pool(&source), one_connection_pool(&target));
    let sessions = sessions_with(&source, &source_pool).await;
    *sessions.slot_for("target").lock().await = Some(crate::session::Session {
        browse_client: backend(&target),
        server: "target".into(),
        origin_base: String::new(),
        transfer_pool: target_pool.clone(),
        browse_timeout_ms: 1000,
    });
    let progress = ProgressEmitter::for_tests(|_| {});
    let copy = transfer_remote_copy(
        &sessions,
        &progress,
        "test".into(),
        "target".into(),
        "copy".into(),
        "/source".into(),
        "/copied".into(),
        None,
    );
    tokio::pin!(copy);
    tokio::select! {
        _ = &mut copy => panic!("the source stalls"),
        _ = source.writing.notified() => {}
    }
    let writer = Reservation::acquire_remote(&sessions, "test", "/source", Access::Write).await;
    assert_eq!(
        CommandError::from_anyhow(&writer.err().unwrap()).code,
        ErrorCode::Busy
    );
    assert!(
        Reservation::acquire_remote(&sessions, "test", "/source", Access::Read)
            .await
            .is_ok()
    );
    source_pool.cancel("copy:src");
    target_pool.cancel("copy:dst");
    assert!(copy.await.is_err());
    assert!(
        Reservation::acquire_remote(&sessions, "test", "/source", Access::Write)
            .await
            .is_ok()
    );
    source_pool.destroy().await;
    target_pool.destroy().await;
}

#[test]
fn remote_staging_names_are_distinct_siblings() {
    let first = remote_partial_path("/dir/report.ftpeach-old");
    let second = remote_partial_path("/dir/report.txt");
    assert_ne!(first, second);
    assert!(first.starts_with("/dir/.ftpeach-"));
}

#[test]
fn remote_directory_move_requires_a_shared_session_and_non_nested_target() {
    assert!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/folder/child".into(),
            "same".into(),
            "same".into(),
            true
        )
        .is_err()
    );
    assert!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/alias/child".into(),
            "first".into(),
            "second".into(),
            true
        )
        .is_err()
    );
    assert!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/other/folder".into(),
            "same".into(),
            "same".into(),
            true
        )
        .is_ok()
    );
    assert!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/folder".into(),
            "first".into(),
            "second".into(),
            false
        )
        .is_ok()
    );
}
