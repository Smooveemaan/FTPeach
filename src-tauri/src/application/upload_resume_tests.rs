use super::*;
use crate::protocol::{BackendResult, EntryInfo, ProgressSink, ProtocolBackend};
use crate::session::Session;
use crate::transfer::transfer_pool::{PoolSize, TransferPool};
use crate::transfer::upload_staging::{MARK_CAP, discard_for_connection};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Default)]
struct Remote {
    files: Mutex<HashMap<String, Vec<u8>>>,
    /// Mirrors a protocol with no ranged read, which must never be resumed.
    refuse_ranged_read: bool,
    /// Translation keys this connection put in front of the user.
    logged: Mutex<Vec<String>>,
    /// Every byte range asked of the server, as `(offset, len)`. What a resume
    /// costs the user is exactly what it reads back.
    ranges: Mutex<Vec<(u64, usize)>>,
}

struct Backend {
    remote: Arc<Remote>,
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
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn set_log_enabled(&mut self, _: bool) {}
    fn set_log_sink(
        &mut self,
        _: Option<Arc<dyn Fn(crate::protocol::LogText, crate::protocol::LogKind) + Send + Sync>>,
    ) {
    }
    fn log_event(&self, key: &'static str, _: serde_json::Value, _: crate::protocol::LogKind) {
        self.remote.logged.lock().unwrap().push(key.to_string());
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
    async fn rename(&mut self, _: &str, _: &str) -> BackendResult<()> {
        unreachable!()
    }
    async fn size(&mut self, path: &str) -> u64 {
        self.remote
            .files
            .lock()
            .unwrap()
            .get(path)
            .map_or(0, |bytes| bytes.len() as u64)
    }
    async fn read_range(&mut self, path: &str, offset: u64, len: usize) -> BackendResult<Vec<u8>> {
        self.remote.ranges.lock().unwrap().push((offset, len));
        if self.remote.refuse_ranged_read {
            return Err(crate::protocol::fail(
                crate::ipc::ErrorCode::InvalidInput,
                "This protocol cannot read a byte range",
            ));
        }
        let files = self.remote.files.lock().unwrap();
        let bytes = files.get(path).cloned().unwrap_or_default();
        let from = (offset as usize).min(bytes.len());
        let to = (from + len).min(bytes.len());
        Ok(bytes[from..to].to_vec())
    }
    async fn upload(
        &mut self,
        _: &std::path::Path,
        _: &str,
        _: bool,
        _: ProgressSink,
    ) -> BackendResult<()> {
        unreachable!()
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
        _: &mut (dyn AsyncRead + Unpin + Send),
        _: &str,
    ) -> BackendResult<()> {
        unreachable!()
    }
}

/// A live session over an in-memory server, reachable through `Sessions` the
/// same way the real upload path reaches it.
async fn session_for(remote: &Arc<Remote>) -> (Sessions, String) {
    let sessions = Sessions::default();
    let connection_id = uuid::Uuid::new_v4().to_string();
    let factory_remote = remote.clone();
    let pool = TransferPool::new(
        Arc::new(move || {
            let remote = factory_remote.clone();
            Box::pin(async move {
                Ok(Box::new(Backend { remote }) as crate::transfer::transfer_pool::BoxBackend)
            })
        }),
        PoolSize::Fixed(1),
    );
    let slot = sessions.slot_for(&connection_id);
    *slot.lock().await = Some(Session {
        browse_client: Box::new(Backend {
            remote: remote.clone(),
        }),
        server: connection_id.clone(),
        transfer_pool: pool,
        browse_timeout_ms: 1_000,
    });
    (sessions, connection_id)
}

struct Fixture {
    sessions: Sessions,
    remote: Arc<Remote>,
    key: Key,
    local: PathBuf,
    root: PathBuf,
    staging: String,
}

impl Fixture {
    /// A destination with `staged` already on the server and `source` on disk,
    /// remembered as a paused upload ready to be resumed.
    async fn new(source: &[u8], staged: &[u8], refuse_ranged_read: bool) -> Self {
        let remote = Arc::new(Remote {
            refuse_ranged_read,
            ..Remote::default()
        });
        let staging = "/dir/.ftpeach-staging.part".to_string();
        remote
            .files
            .lock()
            .unwrap()
            .insert(staging.clone(), staged.to_vec());
        let (sessions, connection_id) = session_for(&remote).await;
        let root = std::env::temp_dir().join(format!("ftpeach-resume-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let local = root.join("source.bin");
        tokio::fs::write(&local, source).await.unwrap();
        let key = Key {
            connection_id,
            remote_path: "/dir/target".into(),
        };
        let fixture = Self {
            sessions,
            remote,
            key,
            local,
            root,
            staging,
        };
        fixture.remember_current().await;
        fixture
    }

    async fn remember_current(&self) {
        remember(
            self.key.clone(),
            self.staging.clone(),
            self.local.to_string_lossy().into_owned(),
            pin(&self.local).await.unwrap(),
            0,
        );
    }

    async fn resolve_now(&self) -> Option<(String, u64)> {
        let now = pin(&self.local).await.unwrap();
        resolve(&self.sessions, &self.key, &self.local, now).await
    }

    fn staging_exists(&self) -> bool {
        self.remote
            .files
            .lock()
            .unwrap()
            .contains_key(&self.staging)
    }

    fn logged(&self) -> Vec<String> {
        self.remote.logged.lock().unwrap().clone()
    }

    fn ranges_read(&self) -> Vec<(u64, usize)> {
        self.remote.ranges.lock().unwrap().clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn staged_prefix_of_an_unchanged_source_resumes_at_its_length() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;

    assert_eq!(
        fixture.resolve_now().await,
        Some((fixture.staging.clone(), 5))
    );
}

/// Resuming has to cost the same whether five bytes or five gigabytes were
/// already staged. Verification bytes are paced by the bandwidth limit, so a
/// window that tracked progress made each resume slower than the one before it.
#[tokio::test]
async fn verification_reads_back_a_bounded_tail_however_much_was_staged() {
    let window = VERIFY_WINDOW as usize;
    let source: Vec<u8> = (0..window * 3).map(|i| (i % 251) as u8).collect();
    let staged = &source[..window * 2];
    let fixture = Fixture::new(&source, staged, false).await;

    assert_eq!(
        fixture.resolve_now().await,
        Some((fixture.staging.clone(), staged.len() as u64))
    );
    assert_eq!(
        fixture.ranges_read(),
        [(staged.len() as u64 - VERIFY_WINDOW, window)],
        "the tail proves the overlap; re-reading the whole prefix only costs time"
    );
}

/// The window ends at the staging file's length, so a prefix shorter than the
/// window is read whole rather than from a negative offset.
#[tokio::test]
async fn a_prefix_shorter_than_the_window_is_read_from_the_start() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;

    assert!(fixture.resolve_now().await.is_some());
    assert_eq!(fixture.ranges_read(), [(0, 5)]);
}

#[tokio::test]
async fn a_source_edited_while_paused_restarts_and_drops_its_staging() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;
    tokio::fs::write(&fixture.local, b"hello there, world")
        .await
        .unwrap();

    assert_eq!(fixture.resolve_now().await, None);
    assert!(!fixture.staging_exists());
}

/// The pin cannot see an edit that preserves size and mtime, so the bytes on
/// the wire have to be the ones that catch it.
#[tokio::test]
async fn staging_that_is_not_a_prefix_restarts_even_when_the_pin_matches() {
    let fixture = Fixture::new(b"hello world", b"hellX", false).await;

    assert_eq!(fixture.resolve_now().await, None);
    assert!(!fixture.staging_exists());
}

#[tokio::test]
async fn staging_longer_than_its_source_restarts() {
    let fixture = Fixture::new(b"tiny", b"much longer than the source", false).await;

    assert_eq!(fixture.resolve_now().await, None);
    assert!(!fixture.staging_exists());
}

#[tokio::test]
async fn empty_staging_has_nothing_to_resume() {
    let fixture = Fixture::new(b"hello world", b"", false).await;

    assert_eq!(fixture.resolve_now().await, None);
    assert!(!fixture.staging_exists());
}

#[tokio::test]
async fn a_protocol_without_ranged_reads_never_resumes() {
    let fixture = Fixture::new(b"hello world", b"hello", true).await;

    assert_eq!(fixture.resolve_now().await, None);
    assert!(!fixture.staging_exists());
}

#[tokio::test]
async fn another_local_file_cannot_adopt_the_staging() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;
    let impostor = fixture.root.join("impostor.bin");
    tokio::fs::write(&impostor, b"hello world").await.unwrap();

    let now = pin(&impostor).await.unwrap();
    assert_eq!(
        resolve(&fixture.sessions, &fixture.key, &impostor, now).await,
        None
    );
    assert!(!fixture.staging_exists());
}

#[tokio::test]
async fn resolving_twice_cannot_hand_the_same_staging_to_two_attempts() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;

    assert!(fixture.resolve_now().await.is_some());
    assert_eq!(fixture.resolve_now().await, None);
    // Claimed, not abandoned: the first attempt still owns it.
    assert!(fixture.staging_exists());
}

#[tokio::test]
async fn discarding_a_destination_deletes_the_staging_it_held() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;

    discard(&fixture.sessions, &fixture.key).await;

    assert!(!fixture.staging_exists());
    assert_eq!(fixture.resolve_now().await, None);
}

#[tokio::test]
async fn tearing_down_a_connection_deletes_every_staging_it_held() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;
    let mut browse = Backend {
        remote: fixture.remote.clone(),
    };

    discard_for_connection(&mut browse, &fixture.key.connection_id).await;

    assert!(!fixture.staging_exists());
}

/// Restarting is invisible from the outside — the upload simply runs again from
/// zero — so this log line is the only thing separating "we checked, and these
/// bytes could not be trusted" from "resuming silently never happened".
#[tokio::test]
async fn every_refused_resume_names_its_reason_in_the_connection_log() {
    let edited = Fixture::new(b"hello world", b"hello", false).await;
    tokio::fs::write(&edited.local, b"hello there, world")
        .await
        .unwrap();
    assert_eq!(edited.resolve_now().await, None);
    assert_eq!(edited.logged(), ["uploadRestartedSourceChanged"]);

    let torn = Fixture::new(b"hello world", b"hellX", false).await;
    assert_eq!(torn.resolve_now().await, None);
    assert_eq!(torn.logged(), ["uploadRestartedMismatch"]);

    let unreadable = Fixture::new(b"hello world", b"hello", true).await;
    assert_eq!(unreadable.resolve_now().await, None);
    assert_eq!(unreadable.logged(), ["uploadRestartedUnverified"]);
}

#[tokio::test]
async fn a_resumed_upload_says_so_rather_than_appending_silently() {
    let fixture = Fixture::new(b"hello world", b"hello", false).await;

    assert!(fixture.resolve_now().await.is_some());
    assert_eq!(fixture.logged(), ["uploadResumed"]);
}

#[tokio::test]
async fn a_pause_mark_is_consumed_by_the_attempt_it_aborts() {
    let transfer_id = uuid::Uuid::new_v4().to_string();

    mark_paused(&transfer_id);

    assert!(take_pause_mark(&transfer_id));
    assert!(!take_pause_mark(&transfer_id));
}

#[test]
fn unconsumed_pause_marks_cannot_grow_without_bound() {
    let ids: Vec<String> = (0..MARK_CAP + 8)
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect();
    for id in &ids {
        mark_paused(id);
    }

    assert!(!take_pause_mark(&ids[0]));
    assert!(take_pause_mark(ids.last().unwrap()));
}
