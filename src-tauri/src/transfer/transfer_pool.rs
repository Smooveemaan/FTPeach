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
/// How long a pool with nothing to do keeps its logins: long enough for files
/// sent one after another to reuse them.
#[cfg(not(test))]
const IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(test)]
const IDLE_RELEASE: std::time::Duration = std::time::Duration::from_millis(200);
/// How long a login refused for the server's user limit waits for idle pools
/// to log out before it tries again.
#[cfg(not(test))]
const IDLE_LOGOUT_WAIT: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(test)]
const IDLE_LOGOUT_WAIT: std::time::Duration = std::time::Duration::from_millis(50);
/// Woken when a server turns a login away for its user limit: every pool with
/// nothing to do logs out at once instead of after IDLE_RELEASE.
static IDLE_WANTED: std::sync::LazyLock<Notify> = std::sync::LazyLock::new(Notify::new);
/// How long a waiting relay goes without looking again when no transfer ends:
/// the delay before it notices Stop, a closed pool or a worker freed quietly.
const PAIR_RECHECK: std::time::Duration = std::time::Duration::from_millis(100);

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
    /// A pool of exactly this many workers, which only tests ask for.
    #[cfg(any(test, feature = "test-utils"))]
    Fixed(usize),
    Capped(usize),
    Unlimited,
}

impl PoolSize {
    fn satisfied(&self, current: usize, needed: usize) -> bool {
        match self {
            #[cfg(any(test, feature = "test-utils"))]
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
    pair_turn: Arc<AsyncMutex<()>>,
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
            pair_turn: Arc::new(AsyncMutex::new(())),
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

    /// Grows the pool for its queued and running work plus `spare` idle
    /// workers, which a relay needs before it can be admitted.
    async fn ensure_workers_for(&self, spare: usize) {
        self.growth_changed.notify_one();
        // Login belongs to the pool, not to the transfer that requested it.
        // Dropping that transfer's waiter must not abandon a half-open login:
        // the server can keep counting it until authentication has finished.
        let pool = self.clone();
        let _ = tokio::spawn(async move { pool.grow_workers(spare).await }).await;
    }

    async fn grow_workers(&self, spare: usize) {
        let _gate = self.growing_gate.lock().await;
        let mut connecting = tokio::task::JoinSet::new();
        let mut last_error = None;
        let mut asked_idle_out = false;
        loop {
            loop {
                let need_more = {
                    let state = self.state.lock().unwrap();
                    // Pending logins reserve capacity before any network work begins.
                    let total = state.workers.len() + state.active.len() + connecting.len();
                    let needed = state.queue.len() + state.active.len() + spare;
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
                        && (transfer_limit == 0 || total < transfer_limit.max(spare))
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
                    if spare == 0 {
                        self.drain();
                    }
                }
                // Server may be refusing extra connections — degrade to
                // fewer workers rather than failing outright.
                Err(error) => {
                    // Kept with its code: a server at its user limit says so
                    // to every transfer that waited for this connection.
                    let failure = crate::ipc::CommandError::from_anyhow(&error);
                    // The server may be full of this app's own idle logins:
                    // ask them out and try once more before giving up.
                    if failure.code == ErrorCode::ResourceLimit && !asked_idle_out {
                        asked_idle_out = true;
                        IDLE_WANTED.notify_waiters();
                        tokio::time::sleep(IDLE_LOGOUT_WAIT).await;
                        continue;
                    }
                    let mut state = self.state.lock().unwrap();
                    state.retry_growth_after =
                        Some(tokio::time::Instant::now() + GROWTH_RETRY_DELAY);
                    last_error = Some(failure);
                }
            }
        }
        if let Some(error) = last_error {
            let mut state = self.state.lock().unwrap();
            // Nothing left to run the queue: each waiting transfer gets the
            // reason. The pool stays open, so a retry logs in afresh once
            // the server has room again.
            if !state.destroyed && state.workers.is_empty() && state.active.is_empty() {
                for item in state.queue.drain(..) {
                    let _ = item.respond.send(Err(fail(
                        error.code,
                        format!("Transfer worker replacement failed: {}", error.message),
                    )));
                }
            }
        }
    }

    pub async fn run(&self, task_id: TaskId, task: TaskFn) -> BackendResult<()> {
        self.run_notified(task_id, task, || {}).await
    }

    /// Whether a relay leg could take one of `need` idle workers now. A busy
    /// pool says no; one that will never have them is an error.
    fn leg_ready(&self, state: &PoolState, id: &str, need: usize) -> BackendResult<bool> {
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
        if !state.queue.is_empty() {
            return Ok(false);
        }
        if state.workers.len() >= need {
            return Ok(true);
        }
        // Busy workers come back. An idle pool that is at its size, or was
        // just refused another login, will not get the missing one.
        let refused = !state.workers.is_empty()
            && state
                .retry_growth_after
                .is_some_and(|until| tokio::time::Instant::now() < until);
        if state.active.is_empty() && (refused || self.size.satisfied(state.workers.len(), need)) {
            return Err(fail(
                ErrorCode::ResourceLimit,
                "Copying within one server needs two connections to it, and only one is available",
            ));
        }
        Ok(false)
    }

    /// Admit both relay legs together, as soon as both can start. A relay that
    /// has to wait holds neither worker, so opposite relays cannot deadlock.
    pub async fn run_pair(
        &self,
        other: &Self,
        source: (TaskId, TaskFn, Box<dyn FnOnce() + Send>),
        target: (TaskId, TaskFn, Box<dyn FnOnce() + Send>),
    ) -> BackendResult<()> {
        let same = Arc::ptr_eq(&self.state, &other.state);
        let need = if same { 2 } else { 1 };
        let (tx_a, rx_a) = oneshot::channel();
        let (tx_b, rx_b) = oneshot::channel();
        let mut a = QueuedTask {
            permit: None,
            task_id: source.0,
            task: source.1,
            respond: tx_a,
            on_dispatch: source.2,
        };
        let mut b = QueuedTask {
            permit: None,
            task_id: target.0,
            task: target.1,
            respond: tx_b,
            on_dispatch: target.2,
        };
        // Relays out of one pool start in the order they were asked for. One
        // that is not first yet only watches for Stop and a closed pool.
        // ponytail: one line per source pool, so a relay waiting for a busy
        // target holds back later ones to other targets; a line per pair of
        // pools if that ever matters.
        let waiting = self.pair_turn.lock();
        tokio::pin!(waiting);
        let turn = loop {
            tokio::select! {
                biased;
                turn = &mut waiting => break turn,
                _ = tokio::time::sleep(PAIR_RECHECK) => {
                    self.leg_ready(&self.state.lock().unwrap(), &a.task_id, need)?;
                }
            }
        };
        loop {
            let changed = self.limiter.changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            self.ensure_workers_for(need).await;
            if !same {
                other.ensure_workers_for(1).await;
            }
            {
                // A relay is one logical transfer. Both legs share its slot so a
                // global limit of one cannot deadlock a source against its target.
                // A stable address order prevents opposite-direction relays from
                // deadlocking while inspecting the two pool states.
                if same {
                    let mut state = self.state.lock().unwrap();
                    if self.leg_ready(&state, &a.task_id, 2)?
                        && self.leg_ready(&state, &b.task_id, 2)?
                        && let Some(permit) = self.limiter.try_acquire()
                    {
                        a.permit = Some(permit.clone());
                        b.permit = Some(permit);
                        state.queue.push_back(a);
                        state.queue.push_back(b);
                        break;
                    }
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
                    if self.leg_ready(source, &a.task_id, 1)?
                        && other.leg_ready(target, &b.task_id, 1)?
                        && let Some(permit) = self.limiter.try_acquire()
                    {
                        a.permit = Some(permit.clone());
                        b.permit = Some(permit);
                        source.queue.push_back(a);
                        target.queue.push_back(b);
                        break;
                    }
                }
            }
            let _ = tokio::time::timeout(PAIR_RECHECK, changed).await;
        }
        drop(turn);
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
            // A task taken off the queue already has its answer, the
            // server's own reason among them; only one still queued is
            // left with nobody to run it.
            if state.workers.is_empty()
                && state.active.is_empty()
                && let Some(pos) = state.queue.iter().position(|item| item.task_id == task_id)
            {
                state.queue.remove(pos);
                return Err(fail(
                    ErrorCode::ConnectionLost,
                    "Failed to establish a connection for the file transfer",
                ));
            }
        }
        self.drain();
        // The pool grew only as far as the limit allowed; a raised limit lets
        // it open the connection this task is still waiting for.
        loop {
            let changed = self.limiter.changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let limit = self.limiter.limit();
            tokio::select! {
                result = &mut rx => return result.unwrap_or_else(|_| Err(fail(ErrorCode::ConnectionLost, "Connection closed"))),
                _ = changed => {}
            }
            // Every transfer that ends wakes this too; only a new limit can grow the pool.
            if self.limiter.limit() == limit {
                continue;
            }
            tokio::select! {
                result = &mut rx => return result.unwrap_or_else(|_| Err(fail(ErrorCode::ConnectionLost, "Connection closed"))),
                _ = self.ensure_workers() => {}
            }
            self.drain();
        }
    }

    /// Cancels a queued, active, or not-yet-queued task ("Stop"/"Pause").
    pub fn cancel(&self, task_id: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(pos) = state.queue.iter().position(|item| item.task_id == task_id) {
            let item = state.queue.remove(pos).unwrap();
            let _ = item
                .respond
                .send(Err(fail(ErrorCode::Cancelled, "Canceled by user")));
            return;
        }
        if let Some(entry) = state.active.get(task_id) {
            entry.token.cancel();
            return;
        }
        state.mark_cancelled(task_id.to_string());
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
                pool.release_when_idle();
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

    /// Logs out of a server this pool has had no work for since
    /// IDLE_RELEASE. Servers cap logins per address, and a tab done with its
    /// transfers must not keep another tab, or another program, out.
    fn release_when_idle(&self) {
        let generation = self.generation.load(Ordering::SeqCst);
        let pool = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(IDLE_RELEASE) => {}
                _ = IDLE_WANTED.notified() => {}
            }
            let idle = {
                let mut state = pool.state.lock().unwrap();
                // A transfer dispatched meanwhile moved the generation on.
                if state.destroyed
                    || !state.active.is_empty()
                    || !state.queue.is_empty()
                    || pool.generation.load(Ordering::SeqCst) != generation
                {
                    return;
                }
                std::mem::take(&mut state.workers)
            };
            for mut backend in idle {
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(5), backend.disconnect())
                        .await;
            }
        });
    }

    /// Allows browse-side preparation to observe shutdown without the slot lock.
    pub async fn closed(&self) {
        self.growth_cancel.cancelled().await;
    }

    /// The session behind this pool is closing or gone.
    pub fn is_closed(&self) -> bool {
        self.growth_cancel.is_cancelled()
    }

    /// Synchronous cancellation also runs when a deadline drops the session.
    pub fn cancel_all(&self) {
        self.growth_cancel.cancel();
        let mut state = self.state.lock().unwrap();
        state.destroyed = true;
        for entry in state.active.values() {
            entry.token.cancel();
        }
        for item in state.queue.drain(..) {
            let _ = item
                .respond
                .send(Err(fail(ErrorCode::Cancelled, "Canceled by user")));
        }
        state.workers.clear();
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
#[path = "transfer_pool_tests.rs"]
mod tests;
