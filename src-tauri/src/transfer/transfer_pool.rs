use super::concurrency_limiter::{ConcurrencyLimiter, Permit};
use crate::ipc::ErrorCode;
use crate::protocol::{BackendResult, ProtocolBackend, fail};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot};
use tokio_util::sync::CancellationToken;

const CANCELLED_CAP: usize = 256;
const GROWTH_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

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
    Capped(usize),
    Unlimited,
}

impl PoolSize {
    fn satisfied(&self, current: usize, needed: usize) -> bool {
        match self {
            PoolSize::Fixed(n) => current >= *n,
            PoolSize::Capped(n) => current >= needed.min(*n),
            PoolSize::Unlimited => current >= needed,
        }
    }
}

struct QueuedTask {
    permit: Option<Arc<Permit>>,
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
    retry_growth_after: Option<tokio::time::Instant>,
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
    limiter: Arc<ConcurrencyLimiter>,
    factory: BackendFactory,
    size: PoolSize,
    state: Arc<StdMutex<PoolState>>,
    growing_gate: Arc<AsyncMutex<()>>,
    growth_cancel: CancellationToken,
    growth_changed: Arc<Notify>,
    generation: Arc<AtomicU64>,
}

impl TransferPool {
    pub fn new(factory: BackendFactory, size: PoolSize) -> Self {
        Self {
            limiter: Arc::default(),
            factory,
            size,
            state: Arc::new(StdMutex::new(PoolState::default())),
            growing_gate: Arc::new(AsyncMutex::new(())),
            growth_cancel: CancellationToken::new(),
            growth_changed: Arc::new(Notify::new()),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn with_limiter(mut self, limiter: Arc<ConcurrencyLimiter>) -> Self {
        self.limiter = limiter;
        self
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
        self.growth_changed.notify_one();
        // Login belongs to the pool, not to the transfer that requested it.
        // Dropping that transfer's waiter must not abandon a half-open login:
        // the server can keep counting it until authentication has finished.
        let pool = self.clone();
        let _ = tokio::spawn(async move { pool.grow_workers(minimum).await }).await;
    }

    async fn grow_workers(&self, minimum: usize) {
        let _gate = self.growing_gate.lock().await;
        let mut connecting = tokio::task::JoinSet::new();
        let mut last_error = None;
        loop {
            loop {
                let need_more = {
                    let state = self.state.lock().unwrap();
                    // Pending logins reserve capacity before any network work begins.
                    let total = state.workers.len() + state.active.len() + connecting.len();
                    let needed = (state.queue.len() + state.active.len()).max(minimum);
                    let transfer_limit = self.limiter.limit();
                    let cooling_down = total > 0
                        && state
                            .retry_growth_after
                            .is_some_and(|until| tokio::time::Instant::now() < until);
                    // After a refusal, probe with one login rather than another burst.
                    let probe_available =
                        state.retry_growth_after.is_none() || connecting.is_empty();
                    !state.destroyed
                        && !cooling_down
                        && last_error.is_none()
                        && !self.size.satisfied(total, needed)
                        && (transfer_limit == 0 || total < transfer_limit.max(minimum))
                        && probe_available
                };
                if !need_more {
                    break;
                }
                connecting.spawn((self.factory)());
            }
            if connecting.is_empty() {
                break;
            }
            let result = tokio::select! {
                biased;
                _ = self.growth_cancel.cancelled() => {
                    connecting.shutdown().await;
                    break;
                },
                result = connecting.join_next() => match result {
                    Some(Ok(result)) => result,
                    Some(Err(error)) => Err(fail(ErrorCode::ConnectionLost, format!("Connection worker failed: {error}"))),
                    None => break,
                },
                _ = self.growth_changed.notified() => continue,
            };
            match result {
                Ok(backend) => {
                    if let Some(mut backend) = self.try_push_worker(backend) {
                        let _ = backend.disconnect().await;
                        break;
                    }
                    // A usable connection must not wait for subsequent logins.
                    // Pair admission reserves both legs separately below.
                    if minimum == 0 {
                        self.drain();
                    }
                }
                // Server may be refusing extra connections — degrade to
                // fewer workers rather than failing outright.
                Err(error) => {
                    let mut state = self.state.lock().unwrap();
                    state.retry_growth_after =
                        Some(tokio::time::Instant::now() + GROWTH_RETRY_DELAY);
                    last_error = Some(error.to_string());
                }
            }
        }
        if let Some(error) = last_error {
            let mut state = self.state.lock().unwrap();
            if !state.destroyed && state.workers.is_empty() && state.active.is_empty() {
                state.destroyed = true;
                for item in state.queue.drain(..) {
                    let _ = item.respond.send(Err(fail(
                        ErrorCode::ConnectionLost,
                        format!("Transfer worker replacement failed: {error}"),
                    )));
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
        // A relay is one logical transfer. Both legs share its slot so a
        // global limit of one cannot deadlock a source against its target.
        let permit = self.limiter.try_acquire().ok_or_else(|| {
            fail(
                ErrorCode::ResourceLimit,
                "Transfer limit reached; retry when transfers finish",
            )
        })?;
        let a = QueuedTask {
            permit: Some(permit.clone()),
            task_id: source.0,
            task: source.1,
            respond: tx_a,
            on_dispatch: source.2,
        };
        let b = QueuedTask {
            permit: Some(permit),
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
                permit: None,
                task_id: task_id.clone(),
                task,
                respond: tx,
                on_dispatch: Box::new(on_dispatch),
            });
            rx
        };

        self.drain();
        let mut rx = rx;
        // Growth may be waiting on a slow login while this task has already
        // completed or been cancelled. Do not make its caller wait for growth.
        tokio::select! {
            result = &mut rx => return result.unwrap_or_else(|_| Err(fail(ErrorCode::ConnectionLost, "Connection closed"))),
            _ = self.ensure_workers() => {}
        }

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
        let Some((item, backend, generation, token)) = dispatched else {
            return;
        };

        let pool = self.clone();
        tokio::spawn(async move {
            let QueuedTask {
                task_id,
                task,
                respond,
                on_dispatch,
                permit,
            } = item;
            let mut backend = backend;
            let mut started = false;
            let mut held_permit = None;
            let result = tokio::select! {
                biased;
                _ = token.cancelled() => {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), backend.disconnect()).await;
                    Err(fail(ErrorCode::Cancelled, "Canceled by user"))
                },
                res = async {
                    held_permit = Some(match permit {
                        Some(permit) => permit,
                        None => pool.limiter.acquire().await,
                    });
                    on_dispatch();
                    crate::runtime::sleep_guard::shared().transfer_started();
                    started = true;
                    task(&mut backend).await
                } => res,
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
            if started {
                crate::runtime::sleep_guard::shared().transfer_finished();
            }
            drop(held_permit);
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
        self.growth_cancel.cancel();
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

    /// Waits until active tasks and any pending login have observed shutdown
    /// and released their backends. The application-level timeout bounds this wait.
    pub async fn wait_until_idle(&self) {
        loop {
            if self.state.lock().unwrap().active.is_empty() && self.growing_gate.try_lock().is_ok()
            {
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
        let limiter = Arc::new(ConcurrencyLimiter::default());
        limiter.set_limit(1);
        let pool =
            TransferPool::new(fake_factory(), PoolSize::Fixed(2)).with_limiter(limiter.clone());
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
        assert!(limiter.try_acquire().is_some());
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
    async fn shared_limit_queues_other_tabs_and_allows_cancellation_and_live_changes() {
        let limiter = Arc::new(ConcurrencyLimiter::default());
        limiter.set_limit(1);
        let a =
            TransferPool::new(fake_factory(), PoolSize::Unlimited).with_limiter(limiter.clone());
        let b =
            TransferPool::new(fake_factory(), PoolSize::Unlimited).with_limiter(limiter.clone());
        let (started_tx, started_rx) = oneshot::channel();
        let first_pool = a.clone();
        let first = tokio::spawn(async move {
            a.run_notified(
                "first".into(),
                Box::new(|_| Box::pin(std::future::pending())),
                move || {
                    let _ = started_tx.send(());
                },
            )
            .await
        });
        started_rx.await.unwrap();
        let notified = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let spawn_waiter = |id: &'static str| {
            let b = b.clone();
            let notified = notified.clone();
            tokio::spawn(async move {
                b.run_notified(
                    id.into(),
                    Box::new(|_| Box::pin(async { Ok(()) })),
                    move || {
                        notified.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .await
            })
        };
        let cancelled = spawn_waiter("cancelled");
        // The second tab has a worker but must stay queued globally.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(notified.load(Ordering::SeqCst), 0);
        b.cancel("cancelled");
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), cancelled)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        let next = spawn_waiter("next");
        limiter.set_limit(2);
        tokio::time::timeout(std::time::Duration::from_secs(2), next)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(notified.load(Ordering::SeqCst), 1);
        first_pool.cancel("first");
        assert!(first.await.unwrap().is_err());
        assert!(limiter.try_acquire().is_some());
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
    async fn capped_connection_limit_creates_on_demand_and_reuses_workers_for_eight_tasks() {
        let created = Arc::new(AtomicUsize::new(0));
        // A session limit of five reserves the remaining connection for browsing.
        let pool = TransferPool::new(counting_factory(created.clone()), PoolSize::Capped(4));
        pool.ensure_workers_for(1).await;
        assert_eq!(created.load(Ordering::SeqCst), 1);
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let pool = pool.clone();
            let release = release.clone();
            let started = started.clone();
            tasks.spawn(async move {
                pool.run(
                    format!("file-{index}"),
                    Box::new(move |_| {
                        Box::pin(async move {
                            started.send(()).unwrap();
                            release.acquire().await.unwrap().forget();
                            Ok(())
                        })
                    }),
                )
                .await
            });
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            for _ in 0..4 {
                ready.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(created.load(Ordering::SeqCst), 4);
        assert!(ready.try_recv().is_err());
        release.add_permits(8);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(result) = tasks.join_next().await {
                result.unwrap().unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(created.load(Ordering::SeqCst), 4);
        pool.destroy().await;
    }

    #[tokio::test]
    async fn completed_transfers_do_not_abandon_pending_logins_or_exceed_connection_limit() {
        struct PendingLogin(Arc<AtomicUsize>);
        impl Drop for PendingLogin {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        for shutdown_during_login in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let pending = Arc::new(AtomicUsize::new(0));
            let login_started = Arc::new(tokio::sync::Notify::new());
            let release_login = Arc::new(tokio::sync::Semaphore::new(0));
            let factory: BackendFactory = {
                let calls = calls.clone();
                let pending = pending.clone();
                let login_started = login_started.clone();
                let release_login = release_login.clone();
                Arc::new(move || {
                    let index = calls.fetch_add(1, Ordering::SeqCst);
                    let pending = pending.clone();
                    let login_started = login_started.clone();
                    let release_login = release_login.clone();
                    Box::pin(async move {
                        if index > 0 {
                            pending.fetch_add(1, Ordering::SeqCst);
                            let _pending = PendingLogin(pending);
                            login_started.notify_one();
                            release_login.acquire().await.unwrap().forget();
                        }
                        Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
                    })
                })
            };
            // Four total connections: one browse client plus at most three workers.
            let pool = TransferPool::new(factory, PoolSize::Capped(3));
            pool.ensure_workers_for(1).await;
            let release_tasks = Arc::new(tokio::sync::Semaphore::new(0));
            let mut tasks = tokio::task::JoinSet::new();
            for index in 0..8 {
                let pool = pool.clone();
                let release = release_tasks.clone();
                tasks.spawn(async move {
                    pool.run(
                        format!("small-file-{index}"),
                        Box::new(move |_| {
                            Box::pin(async move {
                                release.acquire().await.unwrap().forget();
                                Ok(())
                            })
                        }),
                    )
                    .await
                });
            }
            tokio::time::timeout(std::time::Duration::from_secs(2), login_started.notified())
                .await
                .unwrap();
            release_tasks.add_permits(8);
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while let Some(result) = tasks.join_next().await {
                    result.unwrap().unwrap();
                }
            })
            .await
            .expect("finished transfers must not wait for another connection's login");
            assert_eq!(
                pending.load(Ordering::SeqCst),
                2,
                "both pending logins must outlive completed transfers"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                3,
                "completed files must not restart the pending login"
            );
            if shutdown_during_login {
                pool.destroy().await;
                tokio::time::timeout(std::time::Duration::from_secs(2), pool.wait_until_idle())
                    .await
                    .unwrap();
                assert_eq!(
                    pending.load(Ordering::SeqCst),
                    0,
                    "disconnect must cancel the pending login"
                );
                continue;
            }
            release_login.add_permits(2);
            tokio::time::timeout(std::time::Duration::from_secs(2), pool.ensure_workers())
                .await
                .unwrap();
            assert_eq!(pool.state.lock().unwrap().workers.len(), 3);
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            pool.destroy().await;
        }
    }

    #[tokio::test]
    async fn ready_worker_and_its_result_do_not_wait_for_a_stalled_extra_login() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let factory: BackendFactory = Arc::new(move || {
            let index = seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if index > 0 {
                    std::future::pending::<()>().await;
                }
                Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
            })
        });
        let pool = TransferPool::new(factory, PoolSize::Fixed(4));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            pool.run("first".into(), Box::new(|_| Box::pin(async { Ok(()) }))),
        )
        .await;
        result
            .expect("a ready worker must start without waiting for all logins")
            .unwrap();
        pool.run("reuse".into(), Box::new(|_| Box::pin(async { Ok(()) })))
            .await
            .unwrap();
        pool.destroy().await;
    }

    #[tokio::test]
    async fn parallel_logins_obey_transfer_limit_and_later_login_can_serve_entire_queue() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let factory: BackendFactory = {
            let calls = calls.clone();
            let release = release.clone();
            Arc::new(move || {
                let index = calls.fetch_add(1, Ordering::SeqCst);
                let started = started.clone();
                let release = release.clone();
                Box::pin(async move {
                    started.send(index).unwrap();
                    if index == 0 {
                        std::future::pending::<()>().await;
                    }
                    release.acquire().await.unwrap().forget();
                    Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
                })
            })
        };
        let limiter = Arc::new(ConcurrencyLimiter::default());
        limiter.set_limit(2);
        let pool = TransferPool::new(factory, PoolSize::Capped(3)).with_limiter(limiter);
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let pool = pool.clone();
            tasks.spawn(async move {
                pool.run(
                    format!("parallel-{index}"),
                    Box::new(|_| Box::pin(async { Ok(()) })),
                )
                .await
            });
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut logins = vec![ready.recv().await.unwrap(), ready.recv().await.unwrap()];
            logins.sort();
            assert_eq!(logins, vec![0, 1]);
        })
        .await
        .expect("both logins must start before either one completes");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "the transfer limit also caps connection creation"
        );
        release.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(result) = tasks.join_next().await {
                result.unwrap().unwrap();
            }
        })
        .await
        .expect("a ready second connection must not wait for the stalled first login");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        pool.destroy().await;
        tokio::time::timeout(std::time::Duration::from_secs(2), pool.wait_until_idle())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn refused_parallel_login_does_not_discard_another_pending_success() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let factory: BackendFactory = {
            let release = release.clone();
            Arc::new(move || {
                let index = calls.fetch_add(1, Ordering::SeqCst);
                let started = started.clone();
                let release = release.clone();
                Box::pin(async move {
                    started.send(index).unwrap();
                    if index == 0 {
                        return Err(fail(ErrorCode::ConnectionLost, "421 connection limit"));
                    }
                    release.acquire().await.unwrap().forget();
                    Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
                })
            })
        };
        let pool = TransferPool::new(factory, PoolSize::Fixed(2));
        let worker = pool.clone();
        let task = tokio::spawn(async move {
            worker
                .run("survivor".into(), Box::new(|_| Box::pin(async { Ok(()) })))
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            ready.recv().await.unwrap();
            ready.recv().await.unwrap();
            loop {
                if pool.state.lock().unwrap().retry_growth_after.is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!pool.state.lock().unwrap().destroyed);
        release.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        pool.destroy().await;
    }

    #[tokio::test]
    async fn loss_of_last_worker_bypasses_growth_cooldown() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let factory: BackendFactory = Arc::new(move || {
            let index = seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if index == 1 {
                    return Err(fail(ErrorCode::ConnectionLost, "421 connection limit"));
                }
                Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
            })
        });
        let pool = TransferPool::new(factory, PoolSize::Fixed(2));
        // Establish one worker and encounter the limit before losing it.
        pool.ensure_workers().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(pool.state.lock().unwrap().retry_growth_after.is_some());
        pool.run(
            "disconnect".into(),
            Box::new(|backend| Box::pin(async move { backend.disconnect().await })),
        )
        .await
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            pool.run(
                "replacement".into(),
                Box::new(|_| Box::pin(async { Ok(()) })),
            ),
        )
        .await
        .expect("replacement must not wait for the five-second growth cooldown")
        .unwrap();
        assert!(calls.load(Ordering::SeqCst) >= 3);
        pool.destroy().await;
    }

    #[tokio::test]
    async fn rejected_growth_is_shared_by_queued_callers_and_can_retry_later() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let factory: BackendFactory = Arc::new(move || {
            let index = seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if index > 0 {
                    return Err(fail(ErrorCode::ConnectionLost, "421 connection limit"));
                }
                Ok(Box::new(FakeBackend { connected: true }) as BoxBackend)
            })
        });
        let pool = TransferPool::new(factory, PoolSize::Fixed(4));
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, ready) = oneshot::channel();
        let worker = pool.clone();
        let gate = release.clone();
        let first = tokio::spawn(async move {
            worker
                .run(
                    "first".into(),
                    Box::new(move |_| {
                        Box::pin(async move {
                            let _ = started.send(());
                            gate.notified().await;
                            Ok(())
                        })
                    }),
                )
                .await
        });
        ready.await.unwrap();
        let mut queued = tokio::task::JoinSet::new();
        for index in 0..8 {
            let pool = pool.clone();
            queued.spawn(async move {
                pool.run(
                    format!("queued-{index}"),
                    Box::new(|_| Box::pin(async { Ok(()) })),
                )
                .await
            });
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if pool.state.lock().unwrap().queue.len() == 8 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            4,
            "a refused initial batch must suppress further connection attempts"
        );
        release.notify_one();
        first.await.unwrap().unwrap();
        while let Some(result) = queued.join_next().await {
            result.unwrap().unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        pool.state.lock().unwrap().retry_growth_after = Some(tokio::time::Instant::now());
        pool.ensure_workers().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            5,
            "growth must probe with one connection after the cooldown"
        );
        pool.destroy().await;
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
