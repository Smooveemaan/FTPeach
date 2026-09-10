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
        resume_from: None,
    };
    (root, intent)
}

/// Walks a test wants cut short right after their next delivered file, and how.
static AFTER_FILE: LazyLock<Mutex<HashMap<String, CancelIntent>>> = LazyLock::new(Default::default);

pub(super) fn after_file(id: &str) {
    let how = AFTER_FILE.lock().unwrap().remove(id);
    if let Some(how) = how {
        cancel(id, how);
    }
}

fn interrupt_after_first_file(intent: &Intent, how: CancelIntent) {
    AFTER_FILE.lock().unwrap().insert(intent.id.clone(), how);
}

/// The next attempt of a paused walk.
fn resumed(previous: &Intent) -> Intent {
    Intent {
        id: uuid::Uuid::new_v4().to_string(),
        resume_from: Some(previous.id.clone()),
        ..previous.clone()
    }
}

/// Every file under `root`, relative with '/' separators, sorted.
fn files_under(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    found.sort();
    found
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
async fn walks_share_a_source_that_only_a_move_needs_to_itself() {
    for moving in [false, true] {
        let (root, mut intent) = fixture();
        intent.moving = moving;
        std::fs::write(root.join("source/a"), b"a").unwrap();
        // Another walk sending the same folder somewhere else.
        let other = Reservation::acquire_local(&intent.source.path(""), Access::Read).unwrap();
        let report = run(&Sessions::default(), None, intent).await;
        drop(other);
        if moving {
            assert!(!report.ok);
            assert_eq!(report.errors[0].code, ErrorCode::Busy);
            assert!(root.join("source/a").is_file());
        } else {
            assert!(report.ok, "{:?}", report.errors);
            assert_eq!(std::fs::read(root.join("target/a")).unwrap(), b"a");
        }
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
    cancel(&intent.id, CancelIntent::Stop);
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

#[tokio::test]
async fn a_paused_walk_resumes_past_what_it_already_delivered() {
    for moving in [false, true] {
        let (root, mut intent) = fixture();
        intent.moving = moving;
        std::fs::create_dir_all(root.join("source/sub/deep")).unwrap();
        for (name, contents) in [("a", "one"), ("sub/b", "two"), ("sub/deep/c", "three")] {
            std::fs::write(root.join("source").join(name), contents).unwrap();
        }
        let sessions = Sessions::default();
        interrupt_after_first_file(&intent, CancelIntent::Pause);
        let report = run(&sessions, None, intent.clone()).await;
        assert!(report.paused, "{:?}", report.errors);
        let delivered = files_under(&root.join("target"));
        assert_eq!(delivered.len(), 1, "{delivered:?}");
        // The delivered file's source changes while the walk is paused; the
        // resume must bring the new contents over the copy it made itself.
        std::fs::write(
            root.join("source").join(&delivered[0]),
            "changed while paused",
        )
        .unwrap();
        let report = run(&sessions, None, resumed(&intent)).await;
        assert!(report.ok, "{:?}", report.errors);
        assert_eq!(report.completed, 3);
        assert_eq!(
            files_under(&root.join("target")),
            ["a", "sub/b", "sub/deep/c"]
        );
        assert_eq!(
            std::fs::read_to_string(root.join("target").join(&delivered[0])).unwrap(),
            "changed while paused"
        );
        assert_eq!(root.join("source").exists(), !moving);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn stop_takes_back_only_what_the_walk_created() {
    for pause_first in [false, true] {
        let (root, mut intent) = fixture();
        intent.moving = false;
        intent.overwrite = true;
        std::fs::create_dir_all(root.join("source/old/deep")).unwrap();
        std::fs::create_dir_all(root.join("source/new/deep")).unwrap();
        for name in ["a", "b", "old/deep/c", "new/deep/d"] {
            std::fs::write(root.join("source").join(name), format!("new {name}")).unwrap();
        }
        // What the user already had there: a file the walk overwrites, one it
        // never touches, and a folder it merges into.
        std::fs::create_dir_all(root.join("target/old")).unwrap();
        for name in ["a", "keep", "old/keep"] {
            std::fs::write(root.join("target").join(name), "user").unwrap();
        }
        let sessions = Sessions::default();
        interrupt_after_first_file(
            &intent,
            if pause_first {
                CancelIntent::Pause
            } else {
                CancelIntent::Stop
            },
        );
        let report = run(&sessions, None, intent.clone()).await;
        assert_eq!(report.paused, pause_first);
        if pause_first {
            // Nothing is taken back while the walk may still be resumed.
            assert!(root.join("target/new/deep").is_dir());
            discard(&sessions, &intent.id).await;
        }
        // Overwritten or not, "a" was the user's before the walk began.
        assert_eq!(files_under(&root.join("target")), ["a", "keep", "old/keep"]);
        assert!(!root.join("target/new").exists());
        assert!(!root.join("target/old/deep").exists());
        assert_eq!(files_under(&root.join("source")).len(), 4);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn a_resume_cancelled_before_it_starts_still_settles_the_paused_walk() {
    let (root, mut intent) = fixture();
    intent.moving = false;
    for name in ["a", "b"] {
        std::fs::write(root.join("source").join(name), name).unwrap();
    }
    let sessions = Sessions::default();
    interrupt_after_first_file(&intent, CancelIntent::Pause);
    assert!(run(&sessions, None, intent.clone()).await.paused);
    // Paused again before it scanned: the journal passes on to this attempt.
    let second = resumed(&intent);
    cancel(&second.id, CancelIntent::Pause);
    assert!(run(&sessions, None, second.clone()).await.paused);
    assert_eq!(files_under(&root.join("target")).len(), 1);
    // Stopped before it scanned: what the first attempt wrote is taken back.
    let third = resumed(&second);
    cancel(&third.id, CancelIntent::Stop);
    let report = run(&sessions, None, third).await;
    assert!(!report.paused);
    assert_eq!(report.errors[0].code, ErrorCode::Cancelled);
    assert!(!root.join("target").exists());
    std::fs::remove_dir_all(root).unwrap();
}

/// An in-memory server a test can have pause a walk partway into a transfer.
#[derive(Default)]
struct Server {
    dirs: Vec<String>,
    files: HashMap<String, Vec<u8>>,
    /// The folders and files walks have written to it.
    made: Mutex<Vec<String>>,
    written: Mutex<HashMap<String, Vec<u8>>>,
    /// The walk to pause once a transfer has moved this many bytes.
    pause_at: Mutex<Option<(String, u64)>>,
    /// Every transfer attempt: the file, and the offset it started from.
    starts: Mutex<Vec<(String, u64)>>,
}

impl Server {
    /// Pauses the walk the test named, once a transfer has come this far.
    fn reached(&self, offset: u64) {
        let pause = self
            .pause_at
            .lock()
            .unwrap()
            .take_if(|(_, at)| offset >= *at);
        if let Some((walk, _)) = pause {
            cancel(&walk, CancelIntent::Pause);
        }
    }

    fn move_file(&self, from: &str, to: &str) -> crate::protocol::BackendResult<()> {
        let mut written = self.written.lock().unwrap();
        let bytes = written
            .remove(from)
            .ok_or_else(|| anyhow::anyhow!("{from} is gone"))?;
        written.insert(to.to_owned(), bytes);
        Ok(())
    }
}

struct FakeBackend(Arc<Server>);

fn listed(name: &str, is_directory: bool, size: u64) -> crate::protocol::EntryInfo {
    crate::protocol::EntryInfo {
        name: name.into(),
        is_directory,
        size,
        modified_at: Some("2024-01-01T00:00:00+00:00".into()),
        permissions: None,
        owner: None,
        group: None,
    }
}

#[async_trait::async_trait]
impl crate::protocol::ProtocolBackend for FakeBackend {
    async fn connect(
        &mut self,
        _: &crate::protocol::config::ConnectionConfig,
    ) -> crate::protocol::BackendResult<()> {
        Ok(())
    }
    async fn disconnect(&mut self) -> crate::protocol::BackendResult<()> {
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
    async fn list(
        &mut self,
        path: &str,
    ) -> crate::protocol::BackendResult<Vec<crate::protocol::EntryInfo>> {
        let name_in = |full: &str| {
            full.rsplit_once('/')
                .filter(|(parent, _)| *parent == path)
                .map(|(_, name)| name.to_owned())
        };
        let made = self.0.made.lock().unwrap().clone();
        let written = self.0.written.lock().unwrap().clone();
        let mut entries = Vec::new();
        for directory in self.0.dirs.iter().chain(&made) {
            if let Some(name) = name_in(directory) {
                entries.push(listed(&name, true, 0));
            }
        }
        for (file, bytes) in self.0.files.iter().chain(&written) {
            if let Some(name) = name_in(file) {
                entries.push(listed(&name, false, bytes.len() as u64));
            }
        }
        Ok(entries)
    }
    async fn mkdir(&mut self, path: &str) -> crate::protocol::BackendResult<()> {
        self.0.made.lock().unwrap().push(path.to_owned());
        Ok(())
    }
    async fn create_file(&mut self, _: &str) -> crate::protocol::BackendResult<()> {
        unreachable!()
    }
    async fn remove(&mut self, path: &str, is_dir: bool) -> crate::protocol::BackendResult<()> {
        if is_dir {
            self.0.made.lock().unwrap().retain(|made| made != path);
        } else {
            self.0.written.lock().unwrap().remove(path);
        }
        Ok(())
    }
    async fn rename(&mut self, from: &str, to: &str) -> crate::protocol::BackendResult<()> {
        self.0.move_file(from, to)
    }
    async fn rename_no_replace(
        &mut self,
        from: &str,
        to: &str,
    ) -> crate::protocol::BackendResult<()> {
        anyhow::ensure!(
            !self.0.written.lock().unwrap().contains_key(to),
            "{to} exists"
        );
        self.0.move_file(from, to)
    }
    async fn size(&mut self, path: &str) -> u64 {
        let written = self.0.written.lock().unwrap();
        self.0
            .files
            .get(path)
            .or_else(|| written.get(path))
            .map_or(0, |bytes| bytes.len() as u64)
    }
    async fn read_range(
        &mut self,
        path: &str,
        at: u64,
        len: usize,
    ) -> crate::protocol::BackendResult<Vec<u8>> {
        let written = self.0.written.lock().unwrap();
        let bytes = written.get(path).map(Vec::as_slice).unwrap_or_default();
        let at = (at as usize).min(bytes.len());
        Ok(bytes[at..(at + len).min(bytes.len())].to_vec())
    }
    /// Appends to what the server already holds on a resume, as SFTP and FTP do.
    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        resume: bool,
        progress: crate::protocol::ProgressSink,
    ) -> crate::protocol::BackendResult<()> {
        let bytes = tokio::fs::read(local).await?;
        let size = bytes.len() as u64;
        let start = if resume {
            let written = self.0.written.lock().unwrap();
            written.get(remote).map_or(0, |held| held.len() as u64)
        } else {
            0
        };
        self.0
            .starts
            .lock()
            .unwrap()
            .push((remote.to_owned(), start));
        self.0
            .written
            .lock()
            .unwrap()
            .entry(remote.to_owned())
            .or_default()
            .truncate(start as usize);
        if start > 0 {
            // Waits on a worker reconnecting after the pause, as a resumed
            // download does.
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let mut offset = start;
        for chunk in bytes[start as usize..].chunks(1024) {
            self.0
                .written
                .lock()
                .unwrap()
                .entry(remote.to_owned())
                .or_default()
                .extend_from_slice(chunk);
            offset += chunk.len() as u64;
            progress(crate::protocol::ProgressInfo::Progress {
                bytes: offset,
                total: size,
            });
            self.0.reached(offset);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        Ok(())
    }
    /// Keeps a resumable partial the way every real protocol does.
    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        resume: bool,
        progress: crate::protocol::ProgressSink,
    ) -> crate::protocol::BackendResult<()> {
        use crate::protocol::transfer_file;
        use tokio::io::{AsyncSeekExt, AsyncWriteExt};
        let bytes = self.0.files[remote].clone();
        let size = bytes.len() as u64;
        let source = transfer_file::SourceIdentity {
            endpoint: "fake".into(),
            remote_path: remote.into(),
            size: Some(size),
            version: Some("v1".into()),
        };
        let (partial, start) = transfer_file::prepare(local, resume, source).await?;
        self.0
            .starts
            .lock()
            .unwrap()
            .push((remote.to_owned(), start));
        if start > 0 {
            // A real resume first waits on a worker reconnecting after the
            // pause, which is all the while the walk's row has to show.
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let mut file = tokio::fs::File::from_std(transfer_file::open_artifact(&partial, false)?);
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let mut offset = start;
        for chunk in bytes[start as usize..].chunks(1024) {
            file.write_all(chunk).await?;
            file.flush().await?;
            offset += chunk.len() as u64;
            progress(crate::protocol::ProgressInfo::Progress {
                bytes: offset,
                total: size,
            });
            self.0.reached(offset);
            // Where a real transfer waits on the network, and a cancel lands.
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        drop(file);
        transfer_file::commit(&partial, local).await?;
        Ok(())
    }
    async fn download_to_writer(
        &mut self,
        _: &str,
        _: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> crate::protocol::BackendResult<()> {
        unreachable!()
    }
    async fn upload_from_reader(
        &mut self,
        _: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        _: &str,
    ) -> crate::protocol::BackendResult<()> {
        unreachable!()
    }
}

/// A live session over `server`, reached through `Sessions` as a real one is.
async fn serve(server: &Arc<Server>) -> (Sessions, String) {
    use crate::transfer::transfer_pool::{BoxBackend, PoolSize, TransferPool};
    let sessions = Sessions::default();
    let connection_id = uuid::Uuid::new_v4().to_string();
    let factory_server = server.clone();
    let pool = TransferPool::new(
        Arc::new(move || {
            let server = factory_server.clone();
            Box::pin(async move { Ok(Box::new(FakeBackend(server)) as BoxBackend) })
        }),
        PoolSize::Fixed(1),
    );
    *sessions.slot_for(&connection_id).lock().await = Some(crate::session::Session {
        browse_client: Box::new(FakeBackend(server.clone())),
        server: connection_id.clone(),
        transfer_pool: pool,
        browse_timeout_ms: 1_000,
    });
    (sessions, connection_id)
}

#[tokio::test]
async fn a_paused_download_carries_on_from_its_partial() {
    let root = std::env::temp_dir().join(format!("ftpeach-recursive-{}", uuid::Uuid::new_v4()));
    let big: Vec<u8> = (0..64 * 1024).map(|index| (index % 251) as u8).collect();
    let server = Arc::new(Server {
        dirs: vec!["/src".into(), "/src/sub".into()],
        files: HashMap::from([
            ("/src/a".to_owned(), b"small".to_vec()),
            ("/src/sub/big".to_owned(), big.clone()),
        ]),
        ..Server::default()
    });
    let (sessions, connection_id) = serve(&server).await;
    let intent = Intent {
        id: uuid::Uuid::new_v4().to_string(),
        source: Endpoint::Remote {
            path: "/src".into(),
            connection_id,
        },
        target: Endpoint::Local {
            path: root.join("target").to_string_lossy().into_owned(),
        },
        moving: false,
        overwrite: false,
        skip_existing: false,
        resume_from: None,
    };
    const PAUSE_AT: u64 = 16 * 1024;
    *server.pause_at.lock().unwrap() = Some((intent.id.clone(), PAUSE_AT));
    let quiet = ProgressEmitter::for_tests(|_| {});
    let report = run(&sessions, Some(&quiet), intent.clone()).await;
    assert!(report.paused, "{:?}", report.errors);
    let second = resumed(&intent);
    let walk_id = second.id.clone();
    let first_shown = Arc::new(Mutex::new(None::<u64>));
    let seen = first_shown.clone();
    let progress = ProgressEmitter::for_tests(move |payload| {
        if payload.id == walk_id
            && payload.status == "progress"
            && let Some(bytes) = payload.bytes
        {
            seen.lock().unwrap().get_or_insert(bytes);
        }
    });
    let report = run(&sessions, Some(&progress), second).await;
    assert!(report.ok, "{:?}", report.errors);
    // The row carries on from the partial too, rather than dropping back to
    // the one small file finished before it.
    let shown = first_shown
        .lock()
        .unwrap()
        .expect("the resumed walk reports progress");
    assert!(
        shown >= PAUSE_AT + 5,
        "the resumed row dropped back to {shown}"
    );
    let starts = server.starts.lock().unwrap().clone();
    let from = |file: &str| -> Vec<u64> {
        starts
            .iter()
            .filter(|(path, _)| path == file)
            .map(|(_, start)| *start)
            .collect()
    };
    assert_eq!(
        from("/src/a"),
        [0],
        "a delivered file is never fetched again"
    );
    let big_starts = from("/src/sub/big");
    assert_eq!(big_starts.len(), 2, "{starts:?}");
    assert!(
        big_starts[1] >= PAUSE_AT,
        "the resumed download started over: {starts:?}"
    );
    assert_eq!(std::fs::read(root.join("target/sub/big")).unwrap(), big);
    // Neither a resume record nor a partial outlives a finished download.
    assert_eq!(files_under(&root.join("target")), ["a", "sub/big"]);
    std::fs::remove_dir_all(root).unwrap();
}

const UPLOAD_PAUSE_AT: u64 = 16 * 1024;

/// Uploads a local folder of one small file and one big one into `folder` on
/// `server`, pausing partway into the big one. Tests run side by side and a
/// destination is leased process-wide, so each needs a folder of its own.
async fn paused_upload(
    server: &Arc<Server>,
    progress: &ProgressEmitter,
    folder: &str,
) -> (std::path::PathBuf, Sessions, Intent, Vec<u8>) {
    let root = std::env::temp_dir().join(format!("ftpeach-recursive-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("source/sub")).unwrap();
    std::fs::write(root.join("source/a"), b"small").unwrap();
    let big: Vec<u8> = (0..64 * 1024).map(|index| (index % 251) as u8).collect();
    std::fs::write(root.join("source/sub/big"), &big).unwrap();
    let (sessions, connection_id) = serve(server).await;
    let intent = Intent {
        id: uuid::Uuid::new_v4().to_string(),
        source: Endpoint::Local {
            path: root.join("source").to_string_lossy().into_owned(),
        },
        target: Endpoint::Remote {
            path: folder.into(),
            connection_id,
        },
        moving: false,
        overwrite: false,
        skip_existing: false,
        resume_from: None,
    };
    *server.pause_at.lock().unwrap() = Some((intent.id.clone(), UPLOAD_PAUSE_AT));
    let report = run(&sessions, Some(progress), intent.clone()).await;
    assert!(report.paused, "{:?}", report.errors);
    (root, sessions, intent, big)
}

#[tokio::test]
async fn a_paused_upload_carries_on_from_its_staging_file() {
    let server = Arc::new(Server::default());
    let first_id = Arc::new(Mutex::new(None::<String>));
    let landed_early = Arc::new(Mutex::new(None::<u64>));
    let (watched, landed) = (first_id.clone(), landed_early.clone());
    let watching = ProgressEmitter::for_tests(move |payload| {
        if payload.status == "progress" && !payload.id.ends_with(":file") {
            watched.lock().unwrap().get_or_insert(payload.id.clone());
            if let Some(count) = payload.landed {
                landed.lock().unwrap().get_or_insert(count);
            }
        }
    });
    let (root, sessions, intent, big) = paused_upload(&server, &watching, "/dst/folder").await;
    // The walk said it had made both folders while it was still running, so
    // the pane showing them could list them without waiting for it to end.
    // Reports are flushed in batches, so the first may already count a file.
    assert_eq!(*first_id.lock().unwrap(), Some(intent.id.clone()));
    let landed_early = *landed_early.lock().unwrap();
    assert!(
        landed_early.is_some_and(|count| count >= 2),
        "{landed_early:?}"
    );
    let second = resumed(&intent);
    let walk_id = second.id.clone();
    let first_shown = Arc::new(Mutex::new(None::<u64>));
    let seen = first_shown.clone();
    let progress = ProgressEmitter::for_tests(move |payload| {
        if payload.id == walk_id
            && payload.status == "progress"
            && let Some(bytes) = payload.bytes
        {
            seen.lock().unwrap().get_or_insert(bytes);
        }
    });
    let report = run(&sessions, Some(&progress), second).await;
    assert!(report.ok, "{:?}", report.errors);
    let shown = first_shown
        .lock()
        .unwrap()
        .expect("the resumed walk reports progress");
    assert!(
        shown >= UPLOAD_PAUSE_AT + 5,
        "the resumed row dropped back to {shown}"
    );
    let starts = server.starts.lock().unwrap().clone();
    let big_starts: Vec<u64> = starts
        .iter()
        .filter(|(path, _)| path.starts_with("/dst/folder/sub/"))
        .map(|(_, start)| *start)
        .collect();
    assert_eq!(big_starts.len(), 2, "{starts:?}");
    assert!(
        big_starts[1] >= UPLOAD_PAUSE_AT,
        "the resumed upload started over: {starts:?}"
    );
    assert_eq!(
        starts
            .iter()
            .filter(|(path, _)| !path.starts_with("/dst/folder/sub/"))
            .count(),
        1,
        "a delivered file is never sent again: {starts:?}"
    );
    let written = server.written.lock().unwrap().clone();
    let mut names: Vec<String> = written.keys().cloned().collect();
    names.sort();
    // No staging file outlives the upload it was for.
    assert_eq!(names, ["/dst/folder/a", "/dst/folder/sub/big"]);
    assert_eq!(written["/dst/folder/sub/big"], big);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn stopping_a_paused_upload_takes_back_its_staging_file_and_folders() {
    let server = Arc::new(Server::default());
    let quiet = ProgressEmitter::for_tests(|_| {});
    let (root, sessions, intent, _) = paused_upload(&server, &quiet, "/dst/stopped").await;
    assert!(
        server
            .written
            .lock()
            .unwrap()
            .keys()
            .any(|path| path.starts_with("/dst/stopped/sub/.ftpeach-")),
        "the pause kept the upload's staging file"
    );
    discard(&sessions, &intent.id).await;
    assert!(
        server.written.lock().unwrap().is_empty(),
        "{:?}",
        server.written.lock().unwrap().keys().collect::<Vec<_>>()
    );
    assert!(
        server.made.lock().unwrap().is_empty(),
        "{:?}",
        server.made.lock().unwrap()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_resume_with_no_paused_walk_behind_it_writes_nothing() {
    let (root, intent) = fixture();
    std::fs::write(root.join("source/a"), "a").unwrap();
    let report = run(&Sessions::default(), None, resumed(&intent)).await;
    assert!(!report.ok);
    assert!(!root.join("target").exists());
    assert!(root.join("source/a").is_file());
    std::fs::remove_dir_all(root).unwrap();
}
