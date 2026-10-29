//! Counts active transfers across connections and holds one idle-sleep inhibitor.
//! A dedicated thread creates and drops it: Windows execution state is thread-local,
//! and Linux D-Bus calls must not block Tokio's transfer workers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

struct Inner {
    active: usize,
    enabled: bool,
    sender: mpsc::SyncSender<()>,
    required: Arc<AtomicBool>,
}

impl Inner {
    fn request(&self, required: bool) {
        self.required.store(required, Ordering::SeqCst);
        // One pending wakeup is enough: the worker reads the latest desired state.
        let _ = self.sender.try_send(());
    }
}

/// Process-wide sleep prevention, controlled by active transfers and settings.
pub struct SleepGuard(Mutex<Inner>);

impl SleepGuard {
    /// Starts the worker without inhibiting sleep until a transfer starts.
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        let required = Arc::new(AtomicBool::new(false));
        let worker_required = required.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("sleep-guard".into())
            .spawn(move || run_worker(receiver, worker_required, create_inhibitor))
        {
            log::warn!("Could not start sleep prevention: {error}");
        }
        Self(Mutex::new(Inner {
            active: 0,
            enabled: true,
            sender,
            required,
        }))
    }

    /// Counts a running transfer, acquiring the inhibitor for the first one.
    pub fn transfer_started(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.active += 1;
        if inner.enabled && inner.active == 1 {
            inner.request(true);
        }
    }

    /// Releases the inhibitor when the last running transfer finishes.
    pub fn transfer_finished(&self) {
        let mut inner = self.0.lock().unwrap();
        if inner.active == 0 {
            return;
        }
        inner.active -= 1;
        if inner.enabled && inner.active == 0 {
            inner.request(false);
        }
    }

    /// Applies the saved preference immediately, including during a transfer.
    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = self.0.lock().unwrap();
        if inner.enabled == enabled {
            return;
        }
        inner.enabled = enabled;
        if inner.active > 0 {
            inner.request(enabled);
        }
    }
}

fn create_inhibitor() -> anyhow::Result<keepawake::KeepAwake> {
    Ok(keepawake::Builder::default()
        .idle(true)
        .reason("File transfers in progress")
        .app_name("FTPeach")
        .app_reverse_domain("com.smooveemaan.ftpeach")
        .create()?)
}

fn run_worker<T>(
    receiver: mpsc::Receiver<()>,
    required: Arc<AtomicBool>,
    mut create: impl FnMut() -> anyhow::Result<T>,
) {
    let mut inhibitor = None;
    for () in receiver {
        let required = required.load(Ordering::SeqCst);
        if required && inhibitor.is_none() {
            match create() {
                Ok(guard) => inhibitor = Some(guard),
                Err(error) => log::warn!("Could not prevent idle sleep: {error}"),
            }
        } else if !required {
            inhibitor = None;
        }
    }
}

static SHARED: OnceLock<SleepGuard> = OnceLock::new();

/// The one guard shared by every connection's transfer pool.
pub fn shared() -> &'static SleepGuard {
    SHARED.get_or_init(SleepGuard::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_guard() -> (SleepGuard, mpsc::Receiver<()>) {
        let (sender, receiver) = mpsc::sync_channel(1);
        (
            SleepGuard(Mutex::new(Inner {
                active: 0,
                enabled: true,
                sender,
                required: Arc::new(AtomicBool::new(false)),
            })),
            receiver,
        )
    }

    #[test]
    fn shared_is_a_process_wide_singleton() {
        assert!(std::ptr::eq(shared(), shared()));
    }

    #[test]
    fn concurrent_transfers_hold_one_inhibitor_until_the_last_finishes() {
        let (guard, receiver) = test_guard();
        guard.transfer_finished();
        guard.transfer_started();
        guard.transfer_started();
        guard.transfer_finished();
        assert_eq!(guard.0.lock().unwrap().active, 1);
        assert!(guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        assert_eq!(receiver.try_iter().count(), 1);
        guard.transfer_finished();
        guard.transfer_finished();
        assert_eq!(guard.0.lock().unwrap().active, 0);
        assert!(!guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        assert_eq!(receiver.try_iter().count(), 1);
    }

    #[test]
    fn preference_changes_release_and_reacquire_during_transfers() {
        let (guard, receiver) = test_guard();
        guard.set_enabled(false);
        guard.transfer_started();
        guard.transfer_started();
        assert!(receiver.try_recv().is_err());
        guard.set_enabled(true);
        assert!(guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        guard.set_enabled(true);
        guard.set_enabled(false);
        assert!(!guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        guard.set_enabled(false);
        guard.set_enabled(true);
        assert!(guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        assert_eq!(guard.0.lock().unwrap().active, 2);
        guard.transfer_finished();
        guard.transfer_finished();
        assert!(!guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        assert_eq!(receiver.try_iter().count(), 1);
    }

    #[test]
    fn finishing_while_disabled_does_not_leave_an_inhibitor() {
        let (guard, receiver) = test_guard();
        guard.transfer_started();
        guard.set_enabled(false);
        guard.transfer_finished();
        guard.set_enabled(true);
        assert!(!guard.0.lock().unwrap().required.load(Ordering::SeqCst));
        assert_eq!(receiver.try_iter().count(), 1);
    }

    #[test]
    fn worker_releases_on_the_same_thread_and_on_channel_close() {
        struct Inhibitor(mpsc::Sender<(bool, std::thread::ThreadId)>);
        impl Drop for Inhibitor {
            fn drop(&mut self) {
                self.0.send((false, std::thread::current().id())).unwrap();
            }
        }
        let (events, observed) = mpsc::channel();
        let (sender, receiver) = mpsc::sync_channel(1);
        let required = Arc::new(AtomicBool::new(true));
        let worker_required = required.clone();
        let worker = std::thread::spawn(move || {
            run_worker(receiver, worker_required, || {
                events.send((true, std::thread::current().id())).unwrap();
                Ok(Inhibitor(events.clone()))
            });
        });
        let worker_id = worker.thread().id();
        let next = || {
            observed
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
        };
        sender.send(()).unwrap();
        assert_eq!(next(), (true, worker_id));
        sender.send(()).unwrap();
        required.store(false, Ordering::SeqCst);
        sender.send(()).unwrap();
        assert_eq!(next(), (false, worker_id));
        required.store(true, Ordering::SeqCst);
        sender.send(()).unwrap();
        assert_eq!(next(), (true, worker_id));
        drop(sender);
        worker.join().unwrap();
        assert_eq!(next(), (false, worker_id));
        assert!(observed.try_recv().is_err());
        assert_ne!(worker_id, std::thread::current().id());
    }

    #[test]
    fn worker_survives_an_unavailable_system_api_and_retries() {
        let (sender, receiver) = mpsc::sync_channel(2);
        sender.send(()).unwrap();
        sender.send(()).unwrap();
        drop(sender);
        let mut attempts = 0;
        run_worker(receiver, Arc::new(AtomicBool::new(true)), || {
            attempts += 1;
            if attempts == 1 {
                anyhow::bail!("System service unavailable");
            }
            Ok(())
        });
        assert_eq!(attempts, 2);
    }

    #[test]
    fn a_busy_worker_keeps_only_the_latest_request_without_blocking_transfers() {
        let (guard, receiver) = test_guard();
        for _ in 0..10_000 {
            guard.transfer_started();
            guard.transfer_finished();
        }
        assert_eq!(receiver.try_iter().count(), 1);
        guard.transfer_started();
        guard.transfer_finished();
        let required = guard.0.lock().unwrap().required.clone();
        drop(guard);
        let mut attempts = 0;
        run_worker(receiver, required, || {
            attempts += 1;
            Ok(())
        });
        assert_eq!(attempts, 0);
    }
}
