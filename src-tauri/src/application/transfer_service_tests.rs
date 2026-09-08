use super::*;
use crate::protocol::{BackendResult, EntryInfo, ProtocolBackend};
use crate::transfer::transfer_pool::{BoxBackend, PoolSize, TransferPool};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Default)]
struct Remote {
    files: Mutex<HashMap<String, Vec<u8>>>,
    writing: tokio::sync::Notify,
    stall: bool,
    reject_rename: bool,
}

struct Backend {
    remote: Arc<Remote>,
    connected: bool,
}

#[async_trait::async_trait]
impl ProtocolBackend for Backend {
    async fn connect(
        &mut self,
        _: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        Ok(())
    }
    async fn disconnect(&mut self) -> BackendResult<()> {
        self.connected = false;
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.connected
    }
    fn set_log_enabled(&mut self, _: bool) {}
    fn set_log_sink(
        &mut self,
        _: Option<Arc<dyn Fn(crate::protocol::LogText, crate::protocol::LogKind) + Send + Sync>>,
    ) {
    }
    async fn list(&mut self, _: &str) -> BackendResult<Vec<EntryInfo>> {
        Ok(vec![])
    }
    async fn mkdir(&mut self, _: &str) -> BackendResult<()> {
        unreachable!()
    }
    async fn create_file(&mut self, _: &str) -> BackendResult<()> {
        unreachable!()
    }
    async fn remove(&mut self, path: &str, _: bool) -> BackendResult<()> {
        self.remote.files.lock().unwrap().remove(path);
        Ok(())
    }
    async fn rename(&mut self, old: &str, new: &str) -> BackendResult<()> {
        anyhow::ensure!(
            !self.remote.reject_rename,
            "Server cannot replace via rename"
        );
        let mut files = self.remote.files.lock().unwrap();
        let bytes = files.remove(old).unwrap();
        files.insert(new.into(), bytes);
        Ok(())
    }
    async fn size(&mut self, path: &str) -> u64 {
        self.remote
            .files
            .lock()
            .unwrap()
            .get(path)
            .map_or(0, |bytes| bytes.len() as u64)
    }
    async fn upload(
        &mut self,
        _: &std::path::Path,
        path: &str,
        resume: bool,
        sink: ProgressSink,
    ) -> BackendResult<()> {
        assert!(!resume);
        self.remote
            .files
            .lock()
            .unwrap()
            .insert(path.into(), b"new".to_vec());
        self.remote.writing.notify_one();
        if self.remote.stall {
            std::future::pending::<()>().await;
        }
        sink(ProgressInfo::Done);
        Ok(())
    }
    async fn download(
        &mut self,
        _: &str,
        _: &std::path::Path,
        _: bool,
        _: ProgressSink,
    ) -> BackendResult<()> {
        unreachable!()
    }
    async fn download_to_writer(
        &mut self,
        _: &str,
        _: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> BackendResult<()> {
        unreachable!()
    }
    async fn upload_from_reader(
        &mut self,
        reader: &mut (dyn AsyncRead + Unpin + Send),
        path: &str,
    ) -> BackendResult<()> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        self.remote.files.lock().unwrap().insert(path.into(), bytes);
        Ok(())
    }
}

fn backend(remote: &Arc<Remote>) -> BoxBackend {
    Box::new(Backend {
        remote: remote.clone(),
        connected: true,
    })
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
        let result = upload_staged(
            &mut backend,
            std::path::Path::new("unused"),
            &partial,
            "/target",
            Arc::new(move |event| events_for_sink.lock().unwrap().push(event)),
        )
        .await;
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
async fn queued_and_active_upload_cancellation_preserve_old_target_and_cleanup_only_staging() {
    for queued in [false, true] {
        let remote = fixture(true, false);
        let remote_for_factory = remote.clone();
        let pool = TransferPool::new(
            Arc::new(move || {
                let remote = remote_for_factory.clone();
                Box::pin(async move { Ok(backend(&remote)) })
            }),
            PoolSize::Fixed(1),
        );
        let partial = remote_partial_path("/target");
        let task_partial = partial.clone();
        let task: TaskFn = Box::new(move |backend| {
            Box::pin(async move {
                upload_staged(
                    backend,
                    std::path::Path::new("unused"),
                    &task_partial,
                    "/target",
                    Arc::new(|_| {}),
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
        let sessions = Sessions::default();
        *sessions.slot_for("test").lock().await = Some(crate::session::Session {
            browse_client: backend(&remote),
            transfer_pool: pool.clone(),
            browse_timeout_ms: 1000,
        });
        cleanup_remote_partial(&sessions, "test", &partial).await;
        assert_eq!(remote.files.lock().unwrap().len(), 1);
        assert_old(&remote);
        pool.destroy().await;
    }
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
        let result =
            relay_staged(&mut backend, &partial, "/target", reader, total_rx, done_rx).await;
        assert_eq!(result.is_ok(), completion == Some(true));
        if completion != Some(true) {
            assert_old(&remote);
        }
    }
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
    assert!(matches!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/folder/child".into(),
            "same".into(),
            "same".into(),
            true
        ),
        OkResult::Err { .. }
    ));
    assert!(matches!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/alias/child".into(),
            "first".into(),
            "second".into(),
            true
        ),
        OkResult::Err { .. }
    ));
    assert!(matches!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/other/folder".into(),
            "same".into(),
            "same".into(),
            true
        ),
        OkResult::Ok { ok: true }
    ));
    assert!(matches!(
        transfer_validate_remote_copy(
            "/folder".into(),
            "/folder".into(),
            "first".into(),
            "second".into(),
            false
        ),
        OkResult::Ok { ok: true }
    ));
}
