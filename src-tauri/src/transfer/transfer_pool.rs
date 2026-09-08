use crate::ipc::ErrorCode;
use crate::protocol::{BackendResult, ProtocolBackend, fail};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio_util::sync::CancellationToken;

const CANCELLED_CAP: usize = 256;

pub type TaskId = String;
pub type BoxBackend = Box<dyn ProtocolBackend + Send>;
pub type TaskFn = Box<
    dyn for<'a> FnOnce(
            &'a mut BoxBackend,
        ) -> Pin<Box<dyn Future<Output = BackendResult<()>> + Send + 'a>>
        + Send,
>;
pub type BackendFactory =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = BackendResult<BoxBackend>> + Send>> + Send + Sync>;

#[derive(Clone, Copy)]
pub enum PoolSize {
    Fixed(usize),
    Unlimited,
}

impl PoolSize {
    fn satisfied(&self, current: usize, needed: usize) -> bool {
        match self {
            PoolSize::Fixed(n) => current >= *n,
            PoolSize::Unlimited => current >= needed,
        }
    }
}

struct QueuedTask {
    task_id: TaskId,
    task: TaskFn,
    respond: oneshot::Sender<BackendResult<()>>,
    on_dispatch: Box<dyn FnOnce() + Send>,
}

struct ActiveEntry {
    token: CancellationToken,
    generation: u64,
}

#[derive(Default)]
struct PoolState {
    workers: Vec<BoxBackend>, // invariant: every element here is idle
    queue: VecDeque<QueuedTask>,
    active: HashMap<TaskId, ActiveEntry>,
    cancelled_ids: HashSet<TaskId>,
    // Insertion order for cancelled_ids, so it can be trimmed to
    // CANCELLED_CAP from the oldest end instead of growing unbounded.
    cancelled_order: VecDeque<TaskId>,
    destroyed: bool,
}

impl PoolState {
    fn mark_cancelled(&mut self, task_id: TaskId) {
        if self.cancelled_ids.insert(task_id.clone()) {
            self.cancelled_order.push_back(task_id);
            while self.cancelled_order.len() > CANCELLED_CAP {
                if let Some(oldest) = self.cancelled_order.pop_front() {
                    self.cancelled_ids.remove(&oldest);
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct TransferPool {
    factory: BackendFactory,
    size: PoolSize,
    state: Arc<StdMutex<PoolState>>,
    growing_gate: Arc<AsyncMutex<()>>,
    generation: Arc<AtomicU64>,
}

impl TransferPool {
    pub fn new(factory: BackendFactory, size: PoolSize) -> Self {
        Self {
            factory,
            size,
            state: Arc::new(StdMutex::new(PoolState::default())),
            growing_gate: Arc::new(AsyncMutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    fn try_push_worker(&self, backend: BoxBackend) -> Option<BoxBackend> {
        let mut state = self.state.lock().unwrap();
        if state.destroyed {
            Some(backend)
        } else {
            state.workers.push(backend);
            None
        }
    }

    async fn ensure_workers(&self) {
        self.ensure_workers_for(0).await;
    }

    async fn ensure_workers_for(&self, minimum: usize) {
        let _gate = self.growing_gate.lock().await;
        loop {
            let need_more = {
                let state = self.state.lock().unwrap();
                let total = state.workers.len() + state.active.len();
                let needed = (state.queue.len() + state.active.len()).max(minimum);
                !state.destroyed && !self.size.satisfied(total, needed)
            };
            if !need_more {
                break;
            }
            match (self.factory)().await {
                Ok(backend) => {
                    if let Some(mut backend) = self.try_push_worker(backend) {
                        let _ = backend.disconnect().await;
                        break;
                    }
                }
                // Server may be refusing extra connections — degrade to
                // fewer workers rather than failing outright.
                Err(error) => {
                    let mut state = self.state.lock().unwrap();
                    if state.workers.is_empty() && state.active.is_empty() {
                        state.destroyed = true;
                        for item in state.queue.drain(..) {
                            let _ = item.respond.send(Err(fail(
                                ErrorCode::ConnectionLost,
                                format!("Transfer worker replacement failed: {error}"),
                            )));
                        }
                    }
                    break;
                }
            }
        }
    }

    pub async fn run(&self, task_id: TaskId, task: TaskFn) -> BackendResult<()> {
        self.run_notified(task_id, task, || {}).await
    }

    /// Admit both relay legs together, only when both can start immediately.
    /// Busy or undersized pools return an error without holding either worker.
    pub async fn run_pair(
        &self,
        other: &Self,
        source: (TaskId, TaskFn, Box<dyn FnOnce() + Send>),
        target: (TaskId, TaskFn, Box<dyn FnOnce() + Send>),
    ) -> BackendResult<()> {
        let same = Arc::ptr_eq(&self.state, &other.state);
        self.ensure_workers_for(if same { 2 } else { 1 }).await;
        if !same {
            other.ensure_workers_for(1).await;
        }
        let (tx_a, rx_a) = oneshot::channel();
        let (tx_b, rx_b) = oneshot::channel();
        let a = QueuedTask {
            task_id: source.0,
            task: source.1,
            respond: tx_a,
            on_dispatch: source.2,
        };
        let b = QueuedTask {
            task_id: target.0,
            task: target.1,
            respond: tx_b,
            on_dispatch: target.2,
        };
        fn check(state: &PoolState, id: &str, workers: usize) -> BackendResult<()> {
            if state.destroyed {
                return Err(fail(ErrorCode::ConnectionLost, "Transfer pool is closed"));
            }
            if state.cancelled_ids.contains(id) {
                return Err(fail(ErrorCode::Cancelled, "Canceled by user"));
            }
            if state.active.contains_key(id) || state.queue.iter().any(|q| q.task_id == id) {
                return Err(fail(
                    ErrorCode::InvalidInput,
                    "Transfer attempt is already running",
                ));
            }
            if state.workers.len() < workers || !state.queue.is_empty() {
                return Err(fail(
                    ErrorCode::ResourceLimit,
                    "Relay requires two available workers; increase concurrency or retry when transfers finish",
                ));
            }
            Ok(())
        }
        {
            // A stable address order prevents opposite-direction relays from
            // deadlocking while inspecting the two pool states.
            if same {
                let mut state = self.state.lock().unwrap();
                check(&state, &a.task_id, 2)?;
                check(&state, &b.task_id, 2)?;
                state.queue.push_back(a);
                state.queue.push_back(b);
            } else {
                let (first, second) = if Arc::as_ptr(&self.state) < Arc::as_ptr(&other.state) {
                    (&self.state, &other.state)
                } else {
                    (&other.state, &self.state)
                };
                let mut first = first.lock().unwrap();
                let mut second = second.lock().unwrap();
                let (source, target) = if Arc::as_ptr(&self.state) < Arc::as_ptr(&other.state) {
                    (&mut first, &mut second)
                } else {
                    (&mut second, &mut first)
                };
                check(source, &a.task_id, 1)?;
                check(target, &b.task_id, 1)?;
                source.queue.push_back(a);
                target.queue.push_back(b);
            }
        }
        self.drain();
        other.drain();
        let (a, b) = tokio::join!(rx_a, rx_b);
        a.unwrap_or_else(|_| Err(fail(ErrorCode::ConnectionLost, "Relay source closed")))?;
        b.unwrap_or_else(|_| Err(fail(ErrorCode::ConnectionLost, "Relay target closed")))
    }

    /// Like `run`, but calls `on_dispatch` the moment the task leaves the
    /// queue and is handed a worker — the caller's cue to stop reporting the
    /// task as queued and start reporting it as running.
    pub async fn run_notified(
        &self,
        task_id: TaskId,
        task: TaskFn,
        on_dispatch: impl FnOnce() + Send + 'static,
    ) -> BackendResult<()> {
        let rx = {
            let mut state = self.state.lock().unwrap();
            if state.destroyed {
                return Err(fail(ErrorCode::ConnectionLost, "Transfer pool is closed"));
            }
            if state.active.contains_key(&task_id)
                || state.queue.iter().any(|item| item.task_id == task_id)
            {
                return Err(fail(
                    ErrorCode::InvalidInput,
                    "Transfer attempt is already running",
                ));
            }
            if state.cancelled_ids.remove(&task_id) {
                if let Some(pos) = state.cancelled_order.iter().position(|id| id == &task_id) {
                    state.cancelled_order.remove(pos);
                }
                return Err(fail(ErrorCode::Cancelled, "Canceled by user"));
            }
            let (tx, rx) = oneshot::channel();
            state.queue.push_back(QueuedTask {
                task_id: task_id.clone(),
                task,
                respond: tx,
                on_dispatch: Box::new(on_dispatch),
            });
            rx
        };

        self.ensure_workers().await;

        {
            let mut state = self.state.lock().unwrap();
            if state.workers.is_empty() && state.active.is_empty() {
                if let Some(pos) = state.queue.iter().position(|item| item.task_id == task_id) {
                    state.queue.remove(pos);
                }
                return Err(fail(
                    ErrorCode::ConnectionLost,
                    "Failed to establish a connection for the file transfer",
                ));
            }
        }
        self.drain();
        rx.await
            .unwrap_or_else(|_| Err(fail(ErrorCode::ConnectionLost, "Connection closed")))
    }

    /// Cancels a queued, active, or not-yet-queued task ("Stop"/"Pause").
    pub fn cancel(&self, task_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if let Some(pos) = state.queue.iter().position(|item| item.task_id == task_id) {
            let item = state.queue.remove(pos).unwrap();
            let _ = item
                .respond
                .send(Err(fail(ErrorCode::Cancelled, "Canceled by user")));
            return true;
        }
        if let Some(entry) = state.active.get(task_id) {
            entry.token.cancel();
            return true;
        }
        state.mark_cancelled(task_id.to_string());
        true
    }

    fn drain(&self) {
        let dispatched = {
            let mut state = self.state.lock().unwrap();
            if state.queue.is_empty() || state.workers.is_empty() {
                None
            } else {
                let backend = state.workers.pop().unwrap();
                let item = state.queue.pop_front().unwrap();
                let generation = self.generation.fetch_add(1, Ordering::SeqCst);
                let token = CancellationToken::new();
                state.active.insert(
                    item.task_id.clone(),
                    ActiveEntry {
                        token: token.clone(),
                        generation,
                    },
                );
                Some((item, backend, generation, token))
            }
        };
        let Some((mut item, backend, generation, token)) = dispatched else {
            return;
        };
        let on_dispatch = std::mem::replace(&mut item.on_dispatch, Box::new(|| {}));
        on_dispatch();
        crate::runtime::sleep_guard::shared().transfer_started();

        let pool = self.clone();
        tokio::spawn(async move {
            let QueuedTask {
                task_id,
                task,
                respond,
                ..
            } = item;
            let mut backend = backend;
            let result = tokio::select! {
                res = task(&mut backend) => res,
                _ = token.cancelled() => {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), backend.disconnect()).await;
                    Err(fail(ErrorCode::Cancelled, "Canceled by user"))
                }
            };
            let still_connected = !token.is_cancelled() && backend.is_connected();
            let destroyed = {
                let mut state = pool.state.lock().unwrap();
                if let Some(entry) = state.active.get(&task_id)
                    && entry.generation == generation
                {
                    state.active.remove(&task_id);
                }
                if still_connected && !state.destroyed {
                    state.workers.push(backend);
                }
                state.destroyed
            };
            crate::runtime::sleep_guard::shared().transfer_finished();
            let _ = respond.send(result);
            if destroyed {
                return;
            }
            if still_connected {
                pool.drain();
            } else {
                let pool2 = pool.clone();
                tokio::spawn(async move {
                    pool2.ensure_workers().await;
                    pool2.drain();
                });
            }
        });

        // Pick up more idle workers immediately if several became free at once.
        self.drain();
    }

    /// Forwarded to every *currently idle* worker's backend — new workers
    /// already pick up the setting via the factory closure, an
    /// already-connected idle one needs telling directly. A worker mid
    /// transfer when this is called won't see the change until it goes
    /// idle again (its backend is temporarily owned by the executing task,
    /// not reachable from here) — a deliberate, diagnostic-only gap.
    pub fn set_log_enabled(&self, enabled: bool) {
        let mut state = self.state.lock().unwrap();
        for worker in state.workers.iter_mut() {
            worker.set_log_enabled(enabled);
        }
    }

    pub async fn destroy(&self) {
        let (idle_workers, queued, active_tokens) = {
            let mut state = self.state.lock().unwrap();
            state.destroyed = true;
            let idle_workers: Vec<BoxBackend> = std::mem::take(&mut state.workers);
            let queued: Vec<QueuedTask> = state.queue.drain(..).collect();
            let active_tokens: Vec<CancellationToken> =
                state.active.values().map(|e| e.token.clone()).collect();
            (idle_workers, queued, active_tokens)
        };
        for token in active_tokens {
            token.cancel();
        }
        for item in queued {
            let _ = item
                .respond
                .send(Err(fail(ErrorCode::Cancelled, "Canceled by user")));
        }
        for mut backend in idle_workers {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(5), backend.disconnect()).await;
        }
    }

    /// Waits until every task that was active when destruction began has
    /// observed cancellation and released its backend. The application-level
    /// shutdown timeout bounds this wait.
    pub async fn wait_until_idle(&self) {
        loop {
            if self.state.lock().unwrap().active.is_empty() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::config::ConnectionConfig;
    use crate::protocol::{EntryInfo, ProgressSink, ProtocolBackend};
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncRead, AsyncWrite};

    struct FakeBackend {
        connected: bool,
    }

    #[async_trait::async_trait]
    impl ProtocolBackend for FakeBackend {
        async fn connect(&mut self, _config: &ConnectionConfig) -> BackendResult<()> {
            self.connected = true;
            Ok(())
        }
        async fn disconnect(&mut self) -> BackendResult<()> {
            self.connected = false;
            Ok(())
        }
        fn is_connected(&self) -> bool {
            self.connected
        }
        fn set_log_enabled(&mut self, _enabled: bool) {}
        fn set_log_sink(
            &mut self,
            _sink: Option<
                Arc<dyn Fn(crate::protocol::LogText, crate::protocol::LogKind) + Send + Sync>,
            >,
        ) {
        }
        async fn list(&mut self, _path: &str) -> BackendResult<Vec<EntryInfo>> {
            Ok(vec![])
        }
        async fn mkdir(&mut self, _path: &str) -> BackendResult<()> {
            Ok(())
        }
        async fn create_file(&mut self, _path: &str) -> BackendResult<()> {
            Ok(())
        }
        async fn remove(&mut self, _path: &str, _is_dir: bool) -> BackendResult<()> {
            Ok(())
        }
        async fn rename(&mut self, _old_path: &str, _new_path: &str) -> BackendResult<()> {
            Ok(())
        }
        async fn size(&mut self, _path: &str) -> u64 {
            0
        }
        async fn upload(
            &mut self,
            _local_path: &Path,
            _remote_path: &str,
            _resume: bool,
            _progress: ProgressSink,
        ) -> BackendResult<()> {
            Ok(())
        }
        async fn download(
            &mut self,
            _remote_path: &str,
            _local_path: &Path,
            _resume: bool,
            _progress: ProgressSink,
        ) -> BackendResult<()> {
            Ok(())
        }
        async fn download_to_writer(
            &mut self,
            _remote_path: &str,
            _writer: &mut (dyn AsyncWrite + Unpin + Send),
        ) -> BackendResult<()> {
            Ok(())
        }
        async fn upload_from_reader(
            &mut self,
            _reader: &mut (dyn AsyncRead + Unpin + Send),
            _remote_path: &str,
        ) -> BackendResult<()> {
            Ok(())
        }
    }

    fn fake_factory() -> BackendFactory {
        Arc::new(|| Box::pin(async { Ok(Box::new(FakeBackend { connected: true }) as BoxBackend) }))
    }

    #[tokio::test]
    async fn replacement_failure_finishes_all_waiters_and_rejects_new_work() {
        let count = Arc::new(AtomicUsize::new(0));
        let factory: BackendFactory = Arc::new(move || {
            let count = count.clone();
            Box::pin(async move {
                if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
                } else {
                    Err(fail(ErrorCode::ConnectionRefused, "replacement refused"))
                }
            })
        });
        let pool = TransferPool::new(factory, PoolSize::Fixed(1));
        let release = Arc::new(tokio::sync::Notify::new());
        let (started_tx, started_rx) = oneshot::channel();
        let first = pool.clone();
        let release_task = release.clone();
        let running = tokio::spawn(async move {
            first
                .run_notified(
                    "first".into(),
                    Box::new(move |backend| {
                        Box::pin(async move {
                            release_task.notified().await;
                            backend.disconnect().await
                        })
                    }),
                    move || {
                        let _ = started_tx.send(());
                    },
                )
                .await
        });
        started_rx.await.unwrap();
        assert!(
            pool.run("first".into(), Box::new(|_| Box::pin(async { Ok(()) })))
                .await
                .is_err()
        );
        let mut queued = Vec::new();
        for i in 0..3 {
            let pool = pool.clone();
            queued.push(tokio::spawn(async move {
                pool.run(
                    format!("queued{i}"),
                    Box::new(|_| Box::pin(async { Ok(()) })),
                )
                .await
            }));
        }
        tokio::task::yield_now().await;
        release.notify_one();
        running.await.unwrap().unwrap();
        for task in queued {
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
        }
        assert!(
            pool.run("after".into(), Box::new(|_| Box::pin(async { Ok(()) })))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn same_pool_single_worker_relay_fails_without_starting_either_leg() {
        let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
        let task = || -> TaskFn {
            Box::new(|_| Box::pin(async { panic!("undersized relay must not dispatch") }))
        };
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                pool.run_pair(
                    &pool,
                    ("src".into(), task(), Box::new(|| {})),
                    ("dst".into(), task(), Box::new(|| {}))
                )
            )
            .await
            .unwrap()
            .is_err()
        );
        pool.destroy().await;
        assert!(pool.run("after-destroy".into(), task()).await.is_err());
    }

    #[tokio::test]
    async fn same_pool_pair_streams_more_than_the_duplex_capacity() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(2));
        let (mut writer, mut reader) = tokio::io::duplex(64 * 1024);
        let source: TaskFn = Box::new(move |_| {
            Box::pin(async move {
                writer.write_all(&vec![7; 256 * 1024]).await?;
                Ok(())
            })
        });
        let target: TaskFn = Box::new(move |_| {
            Box::pin(async move {
                let mut data = Vec::new();
                reader.read_to_end(&mut data).await?;
                assert_eq!(data, vec![7; 256 * 1024]);
                Ok(())
            })
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.run_pair(
                &pool,
                ("src".into(), source, Box::new(|| {})),
                ("dst".into(), target, Box::new(|| {})),
            ),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn opposite_relays_and_cancellation_release_both_workers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let a = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
        let b = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let (started_tx, started_rx) = oneshot::channel();
        let source: TaskFn = Box::new(move |_| {
            Box::pin(async move {
                writer.write_all(&vec![1; 256 * 1024]).await?;
                Ok(())
            })
        });
        let target: TaskFn = Box::new(move |_| {
            Box::pin(async move {
                let mut reader = reader;
                std::future::pending::<()>().await;
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes).await?;
                Ok(())
            })
        });
        let a_task = a.clone();
        let b_task = b.clone();
        let running = tokio::spawn(async move {
            a_task
                .run_pair(
                    &b_task,
                    ("forward-src".into(), source, Box::new(|| {})),
                    (
                        "forward-dst".into(),
                        target,
                        Box::new(move || {
                            let _ = started_tx.send(());
                        }),
                    ),
                )
                .await
        });
        started_rx.await.unwrap();
        let noop = || -> TaskFn { Box::new(|_| Box::pin(async { Ok(()) })) };
        assert!(
            b.run_pair(
                &a,
                ("reverse-src".into(), noop(), Box::new(|| {})),
                ("reverse-dst".into(), noop(), Box::new(|| {}))
            )
            .await
            .is_err()
        );
        b.cancel("forward-dst");
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), running)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            a.run("next".into(), noop()),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn fixed_pool_size_caps_concurrent_workers_under_load() {
        let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for i in 0..20 {
            let pool = pool.clone();
            let active = active.clone();
            let max_seen = max_seen.clone();
            handles.push(tokio::spawn(async move {
                let task: TaskFn = Box::new(move |_backend| {
                    Box::pin(async move {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_seen.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                });
                pool.run(format!("t{i}"), task).await
            }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }
        assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn fixed_pool_size_stops_growing_once_at_capacity() {
        let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(3));
        let task: TaskFn = Box::new(|_backend| Box::pin(async { Ok(()) }));
        pool.run("a".into(), task).await.unwrap();
        let task: TaskFn = Box::new(|_backend| Box::pin(async { Ok(()) }));
        pool.run("b".into(), task).await.unwrap();
        // The regression this guards against: growth stopping exactly at
        // `size` and staying there, not compounding further on repeated use.
        assert_eq!(pool.state.lock().unwrap().workers.len(), 3);
    }

    fn counting_factory(created: Arc<AtomicUsize>) -> BackendFactory {
        Arc::new(move || {
            let created = created.clone();
            Box::pin(async move {
                created.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
            })
        })
    }

    #[tokio::test]
    async fn unlimited_pool_grows_to_exactly_one_worker_for_a_single_task() {
        let created = Arc::new(AtomicUsize::new(0));
        let pool = TransferPool::new(counting_factory(created.clone()), PoolSize::Unlimited);

        let task: TaskFn = Box::new(|_backend| Box::pin(async { Ok(()) }));
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            pool.run("solo".into(), task),
        )
        .await
        .expect("run() should not hang growing workers for a single task")
        .unwrap();

        assert_eq!(created.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unlimited_pool_size_grows_only_to_match_pending_tasks() {
        const N: usize = 5;
        let created = Arc::new(AtomicUsize::new(0));
        let pool = TransferPool::new(counting_factory(created.clone()), PoolSize::Unlimited);
        let barrier = Arc::new(tokio::sync::Barrier::new(N));

        let mut handles = Vec::new();
        for i in 0..N {
            let pool = pool.clone();
            let barrier = barrier.clone();
            handles.push(tokio::spawn(async move {
                let task: TaskFn = Box::new(move |_backend| {
                    Box::pin(async move {
                        barrier.wait().await;
                        Ok(())
                    })
                });
                pool.run(format!("t{i}"), task).await
            }));
        }
        for h in handles {
            tokio::time::timeout(std::time::Duration::from_secs(5), h)
                .await
                .expect("run() should not hang")
                .unwrap()
                .unwrap();
        }

        assert_eq!(
            created.load(Ordering::SeqCst),
            N,
            "unlimited pool should grow to match exactly {N} concurrently pending tasks"
        );
    }

    #[tokio::test]
    async fn run_notified_fires_its_hook_only_once_the_task_leaves_the_queue() {
        let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
        let dispatched = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());

        let release_for_blocker = release.clone();
        let blocking_task: TaskFn = Box::new(move |_backend| {
            Box::pin(async move {
                release_for_blocker.notified().await;
                Ok(())
            })
        });
        let pool_for_blocker = pool.clone();
        let blocking_handle =
            tokio::spawn(
                async move { pool_for_blocker.run("blocking".into(), blocking_task).await },
            );

        // Give the blocking task time to actually claim the pool's only worker.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let dispatched_for_hook = dispatched.clone();
        let queued_task: TaskFn = Box::new(|_backend| Box::pin(async { Ok(()) }));
        let pool_for_queued = pool.clone();
        let queued_handle = tokio::spawn(async move {
            pool_for_queued
                .run_notified("queued".into(), queued_task, move || {
                    dispatched_for_hook.fetch_add(1, Ordering::SeqCst);
                })
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(
            dispatched.load(Ordering::SeqCst),
            0,
            "hook must not fire while the task is still queued"
        );

        release.notify_one();
        blocking_handle.await.unwrap().unwrap();
        queued_handle.await.unwrap().unwrap();
        assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    }
}
