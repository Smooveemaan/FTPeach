//! Counts active transfers across connections and holds one idle-sleep inhibitor.
//! A dedicated thread creates and drops it: Windows execution state is thread-local,
//! and Linux D-Bus calls must not block Tokio's transfer workers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

const APP_NAME: &str = "FTPeach";
const APP_ID: &str = "com.smooveemaan.ftpeach";
const INHIBIT_REASON: &str = "File transfers in progress";

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

#[cfg(not(target_os = "linux"))]
fn create_inhibitor() -> anyhow::Result<keepawake::KeepAwake> {
    Ok(keepawake::Builder::default()
        .idle(true)
        .reason(INHIBIT_REASON)
        .app_name(APP_NAME)
        .app_reverse_domain(APP_ID)
        .create()?)
}

#[cfg(target_os = "linux")]
fn create_inhibitor() -> anyhow::Result<linux::LinuxInhibitor> {
    linux::create_inhibitor()
}

#[cfg(any(target_os = "linux", test))]
type BackendAttempt<'a, T> = (&'static str, &'a dyn Fn() -> anyhow::Result<T>);

#[cfg(any(target_os = "linux", test))]
fn try_in_order<T>(backends: &[BackendAttempt<'_, T>]) -> anyhow::Result<T> {
    let mut errors = Vec::new();
    for (name, attempt) in backends {
        match attempt() {
            Ok(guard) => return Ok(guard),
            Err(error) => errors.push(format!("{name}: {error}")),
        }
    }
    anyhow::bail!("{}", errors.join("; "))
}

#[cfg(any(target_os = "linux", test))]
fn combine_inhibitors<S, L>(
    session: anyhow::Result<S>,
    logind: anyhow::Result<L>,
) -> anyhow::Result<(Option<S>, Option<L>)> {
    match (session, logind) {
        (Ok(session), Ok(logind)) => Ok((Some(session), Some(logind))),
        (Ok(session), Err(error)) => {
            log::debug!(
                "System idle inhibitor unavailable; using desktop session inhibitor: {error}"
            );
            Ok((Some(session), None))
        }
        (Err(error), Ok(logind)) => {
            log::debug!(
                "Desktop session suspend inhibitor unavailable; using systemd-logind idle inhibitor: {error}"
            );
            Ok((None, Some(logind)))
        }
        (Err(session_error), Err(logind_error)) => {
            anyhow::bail!("session: {session_error}; logind: {logind_error}")
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{APP_ID, APP_NAME, INHIBIT_REASON, combine_inhibitors, try_in_order};
    use dbus::arg::Variant;
    use dbus::blocking::Connection;
    use std::collections::HashMap;
    use std::time::Duration;

    const DBUS_TIMEOUT: Duration = Duration::from_secs(2);
    // Flag 4 = INHIBIT_SUSPEND on both org.gnome.SessionManager and
    // org.freedesktop.portal.Inhibit (blocks auto-suspend while allowing
    // the display to turn off).
    const INHIBIT_SUSPEND: u32 = 4;

    pub(super) struct LinuxInhibitor {
        _session: Option<SessionInhibitor>,
        _logind: Option<keepawake::KeepAwake>,
    }

    enum SessionRelease {
        Gnome(u32),
        PowerManagement(u32),
        Portal(dbus::Path<'static>),
    }

    struct SessionInhibitor {
        connection: Connection,
        release: SessionRelease,
    }

    impl Drop for SessionInhibitor {
        fn drop(&mut self) {
            match &self.release {
                SessionRelease::Gnome(cookie) => {
                    let proxy = self.connection.with_proxy(
                        "org.gnome.SessionManager",
                        "/org/gnome/SessionManager",
                        DBUS_TIMEOUT,
                    );
                    let _ = proxy.method_call::<(), _, _, _>(
                        "org.gnome.SessionManager",
                        "Uninhibit",
                        (*cookie,),
                    );
                }
                SessionRelease::PowerManagement(cookie) => {
                    let proxy = self.connection.with_proxy(
                        "org.freedesktop.PowerManagement.Inhibit",
                        "/org/freedesktop/PowerManagement/Inhibit",
                        DBUS_TIMEOUT,
                    );
                    let _ = proxy.method_call::<(), _, _, _>(
                        "org.freedesktop.PowerManagement.Inhibit",
                        "UnInhibit",
                        (*cookie,),
                    );
                }
                SessionRelease::Portal(handle) => {
                    let proxy = self.connection.with_proxy(
                        "org.freedesktop.portal.Desktop",
                        &**handle,
                        DBUS_TIMEOUT,
                    );
                    let _ = proxy.method_call::<(), _, _, _>(
                        "org.freedesktop.portal.Request",
                        "Close",
                        (),
                    );
                }
            }
        }
    }

    fn inhibit_gnome(connection: &Connection) -> anyhow::Result<SessionRelease> {
        let proxy = connection.with_proxy(
            "org.gnome.SessionManager",
            "/org/gnome/SessionManager",
            DBUS_TIMEOUT,
        );
        let (cookie,): (u32,) = proxy.method_call(
            "org.gnome.SessionManager",
            "Inhibit",
            (APP_ID, 0u32, INHIBIT_REASON, INHIBIT_SUSPEND),
        )?;
        Ok(SessionRelease::Gnome(cookie))
    }

    fn inhibit_power_management(connection: &Connection) -> anyhow::Result<SessionRelease> {
        let proxy = connection.with_proxy(
            "org.freedesktop.PowerManagement.Inhibit",
            "/org/freedesktop/PowerManagement/Inhibit",
            DBUS_TIMEOUT,
        );
        let (cookie,): (u32,) = proxy.method_call(
            "org.freedesktop.PowerManagement.Inhibit",
            "Inhibit",
            (APP_NAME, INHIBIT_REASON),
        )?;
        Ok(SessionRelease::PowerManagement(cookie))
    }

    fn inhibit_portal(connection: &Connection) -> anyhow::Result<SessionRelease> {
        let proxy = connection.with_proxy(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            DBUS_TIMEOUT,
        );
        let mut options: HashMap<&str, Variant<&str>> = HashMap::new();
        options.insert("reason", Variant(INHIBIT_REASON));
        let (handle,): (dbus::Path<'static>,) = proxy.method_call(
            "org.freedesktop.portal.Inhibit",
            "Inhibit",
            ("", INHIBIT_SUSPEND, options),
        )?;
        Ok(SessionRelease::Portal(handle))
    }

    fn create_session_inhibitor() -> anyhow::Result<SessionInhibitor> {
        // GNOME (gsd-power) and KDE (PowerDevil) ignore systemd-logind's "idle"
        // lock for desktop auto-suspend, so we also register a suspend inhibitor
        // on the user session bus. Keeping this connection open ensures the
        // inhibitor stays active and is automatically released if the process exits.
        let connection = Connection::new_session()?;
        let gnome = || inhibit_gnome(&connection);
        let power_management = || inhibit_power_management(&connection);
        let portal = || inhibit_portal(&connection);
        let release = try_in_order(&[
            ("org.gnome.SessionManager", &gnome),
            ("org.freedesktop.PowerManagement.Inhibit", &power_management),
            ("org.freedesktop.portal.Inhibit", &portal),
        ])?;
        Ok(SessionInhibitor {
            connection,
            release,
        })
    }

    fn create_logind_inhibitor() -> anyhow::Result<keepawake::KeepAwake> {
        Ok(keepawake::Builder::default()
            .idle(true)
            .reason(INHIBIT_REASON)
            .app_name(APP_NAME)
            .app_reverse_domain(APP_ID)
            .create()?)
    }

    pub(super) fn create_inhibitor() -> anyhow::Result<LinuxInhibitor> {
        let (session, logind) =
            combine_inhibitors(create_session_inhibitor(), create_logind_inhibitor())?;
        Ok(LinuxInhibitor {
            _session: session,
            _logind: logind,
        })
    }
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

    #[test]
    fn try_in_order_stops_at_the_first_working_backend_and_reports_all_failures() {
        let calls = Mutex::new(Vec::new());
        let first = || {
            calls.lock().unwrap().push("gnome");
            anyhow::bail!("ServiceUnknown")
        };
        let second = || {
            calls.lock().unwrap().push("power-management");
            Ok("kde-cookie")
        };
        let third = || {
            calls.lock().unwrap().push("portal");
            Ok("portal-handle")
        };
        let selected = try_in_order(&[
            ("gnome", &first),
            ("power-management", &second),
            ("portal", &third),
        ])
        .unwrap();
        assert_eq!(selected, "kde-cookie");
        assert_eq!(*calls.lock().unwrap(), vec!["gnome", "power-management"]);

        let fail_a = || -> anyhow::Result<&str> { anyhow::bail!("missing A") };
        let fail_b = || -> anyhow::Result<&str> { anyhow::bail!("missing B") };
        let error = try_in_order(&[("a", &fail_a), ("b", &fail_b)]).unwrap_err();
        assert_eq!(error.to_string(), "a: missing A; b: missing B");
    }

    #[test]
    fn combine_inhibitors_succeeds_if_either_backend_succeeds_and_fails_only_when_both_fail() {
        assert_eq!(
            combine_inhibitors(Ok("session"), Ok("logind")).unwrap(),
            (Some("session"), Some("logind"))
        );
        assert_eq!(
            combine_inhibitors::<&str, &str>(Ok("session"), Err(anyhow::anyhow!("no logind")))
                .unwrap(),
            (Some("session"), None)
        );
        assert_eq!(
            combine_inhibitors::<&str, &str>(Err(anyhow::anyhow!("no session")), Ok("logind"))
                .unwrap(),
            (None, Some("logind"))
        );
        let error = combine_inhibitors::<&str, &str>(
            Err(anyhow::anyhow!("no session")),
            Err(anyhow::anyhow!("no logind")),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "session: no session; logind: no logind");
    }
}
