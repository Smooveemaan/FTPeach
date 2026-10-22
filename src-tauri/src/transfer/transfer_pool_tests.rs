use super::*;
use crate::protocol::config::ConnectionConfig;
use crate::protocol::{EntryInfo, ProgressSink, ProtocolBackend};
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Default)]
struct FakeBackend {
    connected: bool,
    /// Logins the fake server counts; logging out gives one back.
    logins: Option<Arc<AtomicUsize>>,
}

#[async_trait::async_trait]
impl ProtocolBackend for FakeBackend {
    async fn connect(&mut self, _config: &ConnectionConfig) -> BackendResult<()> {
        self.connected = true;
        Ok(())
    }
    async fn disconnect(&mut self) -> BackendResult<()> {
        if self.connected
            && let Some(logins) = &self.logins
        {
            logins.fetch_sub(1, Ordering::SeqCst);
        }
        self.connected = false;
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.connected
    }
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
    async fn known_size(&mut self, _path: &str) -> Option<u64> {
        Some(0)
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
    Arc::new(|| {
        Box::pin(async {
            Ok(Box::new(FakeBackend {
                connected: true,
                ..Default::default()
            }) as BoxBackend)
        })
    })
}

#[tokio::test]
async fn replacement_failure_finishes_all_waiters_and_rejects_new_work() {
    let count = Arc::new(AtomicUsize::new(0));
    let factory: BackendFactory = Arc::new(move || {
        let count = count.clone();
        Box::pin(async move {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(Box::new(FakeBackend {
                    connected: true,
                    ..Default::default()
                }) as BoxBackend)
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
async fn an_idle_pool_logs_out_but_one_in_use_keeps_its_login() {
    let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
    let idle = || pool.state.lock().unwrap().workers.len();
    let noop = || -> TaskFn { Box::new(|_| Box::pin(async { Ok(()) })) };
    pool.run("first".into(), noop()).await.unwrap();
    tokio::time::sleep(IDLE_RELEASE / 2).await;
    pool.run("second".into(), noop()).await.unwrap();
    // The first transfer's wait ends here, but the second one used the login.
    tokio::time::sleep(IDLE_RELEASE * 3 / 4).await;
    assert_eq!(idle(), 1);
    tokio::time::sleep(IDLE_RELEASE).await;
    assert_eq!(idle(), 0, "nothing ran for IDLE_RELEASE");
    pool.run("later".into(), noop()).await.unwrap();
}

#[tokio::test]
async fn a_login_refused_for_the_user_limit_asks_idle_pools_out_and_gets_in() {
    // A server that lets in one login at a time.
    let logins = Arc::new(AtomicUsize::new(0));
    let factory: BackendFactory = Arc::new(move || {
        let logins = logins.clone();
        Box::pin(async move {
            if logins.fetch_add(1, Ordering::SeqCst) >= 1 {
                logins.fetch_sub(1, Ordering::SeqCst);
                return Err(fail(ErrorCode::ResourceLimit, "1 user (the maximum)"));
            }
            Ok(Box::new(FakeBackend {
                connected: true,
                logins: Some(logins),
            }) as BoxBackend)
        })
    });
    let noop = || -> TaskFn { Box::new(|_| Box::pin(async { Ok(()) })) };
    let done = TransferPool::new(factory.clone(), PoolSize::Fixed(1));
    let next = TransferPool::new(factory, PoolSize::Fixed(1));
    // The first pool keeps its login idle; the second gets it all the same.
    done.run("done".into(), noop()).await.unwrap();
    next.run("next".into(), noop()).await.unwrap();
}

#[tokio::test]
async fn a_server_at_its_user_limit_gives_its_reason_to_the_transfer() {
    let factory: BackendFactory = Arc::new(|| {
        Box::pin(async { Err(fail(ErrorCode::ResourceLimit, "5 users (the maximum)")) })
    });
    let pool = TransferPool::new(factory, PoolSize::Fixed(1));
    let error = pool
        .run("refused".into(), Box::new(|_| Box::pin(async { Ok(()) })))
        .await
        .unwrap_err();
    assert_eq!(
        crate::ipc::CommandError::from_anyhow(&error).code,
        ErrorCode::ResourceLimit,
        "{error:#}"
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
    let pool = TransferPool::new(fake_factory(), PoolSize::Fixed(2)).with_limiter(limiter.clone());
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
    let (a_reverse, b_reverse) = (a.clone(), b.clone());
    let reverse = tokio::spawn(async move {
        b_reverse
            .run_pair(
                &a_reverse,
                ("reverse-src".into(), noop(), Box::new(|| {})),
                ("reverse-dst".into(), noop(), Box::new(|| {})),
            )
            .await
    });
    tokio::time::sleep(2 * PAIR_RECHECK).await;
    assert!(!reverse.is_finished(), "a busy pair must wait, not fail");
    b.cancel("forward-dst");
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), running)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), reverse)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        a.run("next".into(), noop()),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn relays_between_busy_pools_wait_their_turn_in_order_and_can_be_stopped() {
    let a = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
    let b = TransferPool::new(fake_factory(), PoolSize::Fixed(1));
    let order = Arc::new(StdMutex::new(Vec::new()));
    let mut relays = Vec::new();
    for index in 0..4 {
        let (a, b, order) = (a.clone(), b.clone(), order.clone());
        relays.push(tokio::spawn(async move {
            let source: TaskFn = Box::new(move |_| {
                Box::pin(async move {
                    order.lock().unwrap().push(index);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    Ok(())
                })
            });
            let target: TaskFn = Box::new(|_| Box::pin(async { Ok(()) }));
            a.run_pair(
                &b,
                (format!("{index}:src"), source, Box::new(|| {})),
                (format!("{index}:dst"), target, Box::new(|| {})),
            )
            .await
        }));
        // Each relay asks for its turn before the next one exists.
        tokio::task::yield_now().await;
    }
    a.cancel("2:src");
    for (index, relay) in relays.into_iter().enumerate() {
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), relay)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.is_ok(), index != 2, "relay {index}");
    }
    assert_eq!(*order.lock().unwrap(), vec![0, 1, 3]);
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

/// A transfer that holds its connection until it is cancelled, once it runs.
async fn start_endless(
    pool: &TransferPool,
    id: &str,
) -> tokio::task::JoinHandle<BackendResult<()>> {
    let (started_tx, started_rx) = oneshot::channel();
    let (pool, id) = (pool.clone(), id.to_owned());
    let task = tokio::spawn(async move {
        pool.run_notified(
            id,
            Box::new(|_| Box::pin(std::future::pending())),
            move || {
                let _ = started_tx.send(());
            },
        )
        .await
    });
    started_rx.await.unwrap();
    task
}

#[tokio::test]
async fn shared_limit_queues_other_tabs_and_allows_cancellation_and_live_changes() {
    let limiter = Arc::new(ConcurrencyLimiter::default());
    limiter.set_limit(1);
    let a = TransferPool::new(fake_factory(), PoolSize::Unlimited).with_limiter(limiter.clone());
    let b = TransferPool::new(fake_factory(), PoolSize::Unlimited).with_limiter(limiter.clone());
    let first = start_endless(&a, "first").await;
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
    a.cancel("first");
    assert!(first.await.unwrap().is_err());
    assert!(limiter.try_acquire().is_some());
}

#[tokio::test]
async fn raising_the_limit_opens_a_connection_for_a_queued_transfer() {
    let limiter = Arc::new(ConcurrencyLimiter::default());
    limiter.set_limit(1);
    let pool = TransferPool::new(fake_factory(), PoolSize::Unlimited).with_limiter(limiter.clone());
    let first = start_endless(&pool, "first").await;
    // The one connection is busy, so the second file waits for a new one.
    let second_pool = pool.clone();
    let second = tokio::spawn(async move {
        second_pool
            .run("second".into(), Box::new(|_| Box::pin(async { Ok(()) })))
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!second.is_finished());
    limiter.set_limit(2);
    tokio::time::timeout(std::time::Duration::from_secs(2), second)
        .await
        .expect("a raised limit starts the queued transfer")
        .unwrap()
        .unwrap();
    pool.cancel("first");
    assert!(first.await.unwrap().is_err());
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
            Ok(Box::new(FakeBackend {
                connected: true,
                ..Default::default()
            }) as BoxBackend)
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
                    Ok(Box::new(FakeBackend {
                        connected: true,
                        ..Default::default()
                    }) as BoxBackend)
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
            Ok(Box::new(FakeBackend {
                connected: true,
                ..Default::default()
            }) as BoxBackend)
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
                Ok(Box::new(FakeBackend {
                    connected: true,
                    ..Default::default()
                }) as BoxBackend)
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
                Ok(Box::new(FakeBackend {
                    connected: true,
                    ..Default::default()
                }) as BoxBackend)
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
            Ok(Box::new(FakeBackend {
                connected: true,
                ..Default::default()
            }) as BoxBackend)
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
            Ok(Box::new(FakeBackend {
                connected: true,
                ..Default::default()
            }) as BoxBackend)
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
        tokio::spawn(async move { pool_for_blocker.run("blocking".into(), blocking_task).await });

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
