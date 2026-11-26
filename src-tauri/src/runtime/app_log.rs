//! The application log: `log::` records from the backend, and warnings and
//! errors from the interface, written to `ftpeach-app.log` in the logs folder.
//!
//! It runs in release builds too. Update checks, staging-file cleanup, storage
//! and journal failures only ever report through `log::warn!`, and without a
//! file behind it a user's problem left no trace at all. The diagnostic bundle
//! carries the end of this file alongside the in-memory flight recorder.
//!
//! Debug logging rule: inside `protocol::*`, `transfer::*`, and `commands::*`,
//! `log::debug!` is reserved for state transitions, strategy choices, and
//! failures — never per-chunk, per-byte, or per-frame output.

use crate::security::redaction::redact;
use std::collections::VecDeque;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Starts with a letter after `ftpeach-`, so the protocol log's cleanup,
/// which only touches dated `ftpeach-<date>.log` files, leaves it alone.
const FILE_NAME: &str = "ftpeach-app";
/// The plugin renames a full file with a date suffix and keeps this many,
/// the active one included: at most about 3 MiB on disk.
const MAX_FILE_BYTES: u128 = 1024 * 1024;
const KEPT_FILES: usize = 3;
/// How much of the end of the log goes into a diagnostic bundle.
const TAIL_BYTES: u64 = 256 * 1024;

const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(10);
const RATE_LIMIT_BURST: u32 = 5;
const RATE_LIMIT_BUCKETS: usize = 32;
const SIGNATURE_MAX_BYTES: usize = 96;

const FLIGHT_CAPACITY: usize = 200;
const FLIGHT_MAX_MSG_BYTES: usize = 256;
const FLIGHT_DUMP_COOLDOWN: Duration = Duration::from_secs(60);
const FLIGHT_DUMP_TARGET: &str = "app_lib::runtime::app_log::flight_recorder";
const RATE_SUMMARY_TARGET: &str = "app_lib::runtime::app_log::rate_limit";

const PROBE_INTERVAL: Duration = Duration::from_secs(10);
const PROBE_SLOW_MS: u128 = 250;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
pub const EXTENDED_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const EXTENDED_EXPIRED_EVENT: &str = "settings:extended-logging-expired";

static EXTENDED_LOGGING: AtomicBool = AtomicBool::new(false);
static EXTENDED_UNTIL_MS: AtomicI64 = AtomicI64::new(0);
static EXTRA_TARGETS: LazyLock<Vec<String>> = LazyLock::new(|| {
    std::env::var("FTPEACH_LOG_EXTRA")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
});
static RATE_LIMITER: LazyLock<Arc<Mutex<RateLimiter>>> =
    LazyLock::new(|| Arc::new(Mutex::new(RateLimiter::new())));
static FLIGHT_RECORDER: LazyLock<Mutex<FlightRecorder>> =
    LazyLock::new(|| Mutex::new(FlightRecorder::new()));

fn accepts_with_extra(
    metadata: &log::Metadata<'_>,
    extended: bool,
    extra_targets: &[String],
) -> bool {
    if metadata.level() <= log::Level::Info {
        return true;
    }
    if metadata.level() != log::Level::Debug {
        return false;
    }
    let target = metadata.target();
    if extended
        && (target == "app_lib" || target.starts_with("app_lib::") || target == "webview::ipc")
    {
        return true;
    }
    extra_targets
        .iter()
        .any(|prefix| target == prefix || target.starts_with(&format!("{prefix}::")))
}

/// Whether extended diagnostic logging is currently enabled in memory.
pub fn is_extended_enabled() -> bool {
    EXTENDED_LOGGING.load(Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExtendedResolution {
    Disabled,
    Active { until_ms: i64 },
    MigrateFreshDeadline { until_ms: i64 },
    Expired,
}

fn now_epoch_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

fn resolve_extended_logging(settings: &crate::store::JsonMap, now_ms: i64) -> ExtendedResolution {
    let enabled = settings
        .get("extendedLogging")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return ExtendedResolution::Disabled;
    }
    match settings
        .get("extendedLoggingUntil")
        .and_then(serde_json::Value::as_i64)
        .filter(|&value| value > 0)
    {
        Some(until_ms) if until_ms <= now_ms => ExtendedResolution::Expired,
        Some(until_ms) => ExtendedResolution::Active { until_ms },
        None => ExtendedResolution::MigrateFreshDeadline {
            until_ms: now_ms.saturating_add(EXTENDED_TTL_MS),
        },
    }
}

/// Clears an already-expired `extendedLogging` flag in a `settings_get` snapshot
/// so the UI does not flash the indicator while startup persistence finishes.
pub fn normalize_expired_in_snapshot(settings: &mut crate::store::JsonMap) {
    if matches!(
        resolve_extended_logging(settings, now_epoch_ms()),
        ExtendedResolution::Expired
    ) {
        settings.insert("extendedLogging".into(), serde_json::Value::Bool(false));
        settings.insert("extendedLoggingUntil".into(), serde_json::Value::Null);
    }
}

async fn persist_extended_expired(store: &crate::store::Store, app: Option<&AppHandle>) {
    let current = store.get_settings().await;
    if !matches!(
        resolve_extended_logging(&current, now_epoch_ms()),
        ExtendedResolution::Expired
    ) {
        return;
    }
    let mut patch = crate::store::JsonMap::new();
    patch.insert("extendedLogging".into(), serde_json::Value::Bool(false));
    patch.insert("extendedLoggingUntil".into(), serde_json::Value::Null);
    if let Err(error) = store.set_settings(patch).await {
        log::warn!("failed to persist expired extendedLogging state: {error:#}");
        return;
    }
    log::info!("extended diagnostic logging expired after 24h");
    record_event("lifecycle", "extended diagnostic logging expired after 24h");
    if let Some(app) = app {
        let _ = app.emit(EXTENDED_EXPIRED_EVENT, ());
    }
}

async fn persist_extended_migration(store: &crate::store::Store, until_ms: i64) {
    let current = store.get_settings().await;
    if !matches!(
        resolve_extended_logging(&current, now_epoch_ms()),
        ExtendedResolution::MigrateFreshDeadline { .. }
    ) {
        return;
    }
    let mut patch = crate::store::JsonMap::new();
    patch.insert("extendedLoggingUntil".into(), serde_json::json!(until_ms));
    if let Err(error) = store.set_settings(patch).await {
        log::warn!("failed to persist migrated extendedLoggingUntil deadline: {error:#}");
    }
}

/// Applies diagnostic logging immediately, including changes from settings imports.
///
/// Enforces the 24-hour TTL: an expired deadline turns `extendedLogging` off in
/// memory and persists the reset, while a legacy `extendedLogging: true` without
/// `extendedLoggingUntil` receives a fresh 24-hour window.
pub fn apply_settings(
    settings: &crate::store::JsonMap,
    store: Option<&crate::store::Store>,
    app: Option<&AppHandle>,
) {
    let now_ms = now_epoch_ms();
    let resolution = resolve_extended_logging(settings, now_ms);
    let (enabled, until_ms) = match resolution {
        ExtendedResolution::Disabled | ExtendedResolution::Expired => (false, 0),
        ExtendedResolution::Active { until_ms }
        | ExtendedResolution::MigrateFreshDeadline { until_ms } => (true, until_ms),
    };
    EXTENDED_UNTIL_MS.store(until_ms, Ordering::Relaxed);
    if EXTENDED_LOGGING.swap(enabled, Ordering::Relaxed) != enabled {
        log::info!(
            "extended diagnostic logging enabled={enabled}; version={}; os={}; arch={}; pid={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::process::id()
        );
        record_event(
            "lifecycle",
            &format!("extended diagnostic logging enabled={enabled}"),
        );
    }
    match resolution {
        ExtendedResolution::Expired => {
            if let Some(store) = store.cloned() {
                let app = app.cloned();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        persist_extended_expired(&store, app.as_ref()).await;
                    });
                }
            } else if let Some(app) = app {
                let _ = app.emit(EXTENDED_EXPIRED_EVENT, ());
            }
        }
        ExtendedResolution::MigrateFreshDeadline { until_ms } => {
            if let Some(store) = store.cloned()
                && let Ok(handle) = tokio::runtime::Handle::try_current()
            {
                handle.spawn(async move {
                    persist_extended_migration(&store, until_ms).await;
                });
            }
        }
        ExtendedResolution::Disabled | ExtendedResolution::Active { .. } => {}
    }
}

/// Loads the saved diagnostic mode and monitors the native event loop.
///
/// The probe runs unconditionally every 10 seconds with zero disk I/O when
/// healthy (<250 ms), logs slow replies in debug/flight-recorder, and dumps
/// the flight recorder if the main thread stays unresponsive past 2 seconds.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let store = app.state::<crate::store::Store>().inner().clone();
        apply_settings(&store.get_settings().await, Some(&store), Some(&app));
        log::debug!("startup: application logger ready");
        loop {
            tokio::time::sleep(PROBE_INTERVAL).await;
            flush_expired_rate_limit_summaries();
            let until_ms = EXTENDED_UNTIL_MS.load(Ordering::Relaxed);
            if until_ms > 0
                && now_epoch_ms() >= until_ms
                && EXTENDED_LOGGING.swap(false, Ordering::Relaxed)
            {
                EXTENDED_UNTIL_MS.store(0, Ordering::Relaxed);
                persist_extended_expired(&store, Some(&app)).await;
            }
            let started = Instant::now();
            let (reply, mut response) = tokio::sync::oneshot::channel();
            if let Err(error) = app.run_on_main_thread(move || {
                let _ = reply.send(());
            }) {
                log::debug!("main-thread probe could not be queued: {error}");
                return;
            }
            match tokio::time::timeout(PROBE_TIMEOUT, &mut response).await {
                Ok(Ok(())) => {
                    let ms = started.elapsed().as_millis();
                    if ms >= PROBE_SLOW_MS {
                        let msg = format!("main-thread probe slow: {ms}ms");
                        record_event("probe", &msg);
                        log::debug!("{msg}");
                    }
                }
                Ok(Err(_)) => return,
                Err(_) => {
                    log::warn!("main thread unresponsive for >2s");
                    record_event("probe", "main thread unresponsive for >2s");
                    dump_flight_recorder("main-thread-unresponsive");
                    // Keep just this probe queued until the event loop responds.
                    if response.await.is_err() {
                        return;
                    }
                    let ms = started.elapsed().as_millis();
                    let msg = format!("main thread recovered after {ms}ms");
                    record_event("probe", &msg);
                    log::warn!("{msg}");
                }
            }
        }
    });
}

/// Installs the rotating log plugin wrapped with redaction, rate-limiting,
/// and IPC flight-recorder capture.
pub fn init<R: Runtime>(
    app: &AppHandle<R>,
    logs_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut targets = vec![Target::new(TargetKind::Folder {
        path: logs_dir,
        file_name: Some(FILE_NAME.into()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    let mut builder = tauri_plugin_log::Builder::new()
        .targets(targets)
        // Dependencies only when something is wrong; the app's own records
        // from Info up, and Debug when extendedLogging is enabled.
        .level(log::LevelFilter::Warn)
        .level_for("app_lib", log::LevelFilter::Debug)
        .level_for("webview::ipc", log::LevelFilter::Debug)
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(KEPT_FILES))
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} {:<5} {}: {}",
                jiff::ZonedDateTime::now().strftime("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                message
            ));
        });
    for target in EXTRA_TARGETS.iter() {
        builder = builder.level_for(target.clone(), log::LevelFilter::Debug);
    }

    let (plugin, max_level, inner) = builder.split(app)?;
    let logger = AppLogger {
        inner,
        rate_limiter: RATE_LIMITER.clone(),
        extra_targets: EXTRA_TARGETS.clone(),
    };
    log::set_boxed_logger(Box::new(logger))?;
    log::set_max_level(max_level);
    app.plugin(plugin)?;
    Ok(())
}

/// Sends a panic's message and the flight recorder to the log before the
/// default hook runs. Release builds abort on panic, so this is the only
/// record one leaves behind.
pub fn record_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(target: FLIGHT_DUMP_TARGET, "panic: {info}");
        dump_flight_recorder("panic");
        previous(info);
    }));
}

/// Appends a short redacted event to the in-memory flight recorder.
/// Always active regardless of `extendedLogging`, with zero disk I/O.
pub fn record_event(category: &'static str, message: &str) {
    let mut guard = FLIGHT_RECORDER
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    guard.record(category, message);
}

/// Writes the buffered flight recorder events to `ftpeach-app.log`.
///
/// Enforces a 60-second cooldown between dumps except when `reason == "panic"`,
/// which always flushes synchronously before process abort.
pub fn dump_flight_recorder(reason: &str) {
    let force = reason == "panic";
    let events = if force {
        match FLIGHT_RECORDER.try_lock() {
            Ok(mut guard) => guard.prepare_dump(true, Instant::now()),
            Err(_) => None,
        }
    } else {
        let mut guard = FLIGHT_RECORDER
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        guard.prepare_dump(false, Instant::now())
    };
    let Some(events) = events else {
        return;
    };
    log::warn!(
        target: FLIGHT_DUMP_TARGET,
        "flight-recorder dump ({reason}): {} recent event(s)",
        events.len()
    );
    for event in events {
        log::warn!(target: FLIGHT_DUMP_TARGET, "  {event}");
    }
    log::logger().flush();
}

/// Returns the buffered flight recorder events in chronological order.
pub fn recent_events() -> Vec<String> {
    FLIGHT_RECORDER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .recent()
}

fn flush_expired_rate_limit_summaries() {
    let summaries = RATE_LIMITER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .drain_expired(Instant::now());
    for (target, level, signature, suppressed, elapsed_secs) in summaries {
        log::log!(
            target: RATE_SUMMARY_TARGET,
            level,
            "{target}: {signature} (suppressed {suppressed} similar records in {elapsed_secs}s)"
        );
    }
}

struct AppLogger {
    inner: Box<dyn log::Log>,
    rate_limiter: Arc<Mutex<RateLimiter>>,
    extra_targets: Vec<String>,
}

impl AppLogger {
    #[cfg(test)]
    fn new_for_test(
        inner: Box<dyn log::Log>,
        rate_limiter: Arc<Mutex<RateLimiter>>,
        extra_targets: Vec<String>,
    ) -> Self {
        Self {
            inner,
            rate_limiter,
            extra_targets,
        }
    }

    fn log_with_extended(&self, record: &log::Record<'_>, extended: bool, now: Instant) {
        let target = record.target();
        let is_bypass = target == FLIGHT_DUMP_TARGET || target == RATE_SUMMARY_TARGET;
        let is_ipc = target == "webview::ipc";

        if !is_bypass
            && !is_ipc
            && !accepts_with_extra(record.metadata(), extended, &self.extra_targets)
        {
            return;
        }

        let redacted = redact(&record.args().to_string());
        if is_ipc {
            record_event("ipc", &redacted);
        }

        if !is_bypass
            && (!accepts_with_extra(record.metadata(), extended, &self.extra_targets)
                || !self.inner.enabled(record.metadata()))
        {
            return;
        }

        let final_message = if is_bypass {
            redacted
        } else {
            let decision = self
                .rate_limiter
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .check(target, record.level(), &redacted, now);
            match decision {
                RateLimitDecision::Drop => return,
                RateLimitDecision::Allow => redacted,
                RateLimitDecision::AllowWithSummary {
                    suppressed,
                    elapsed_secs,
                } => format!(
                    "{redacted} (suppressed {suppressed} similar records in {elapsed_secs}s)"
                ),
            }
        };

        let mut builder = log::Record::builder();
        builder
            .metadata(record.metadata().clone())
            .module_path(record.module_path())
            .file(record.file())
            .line(record.line());
        self.inner
            .log(&builder.args(format_args!("{final_message}")).build());
    }
}

impl log::Log for AppLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        let target = metadata.target();
        if target == FLIGHT_DUMP_TARGET || target == RATE_SUMMARY_TARGET || target == "webview::ipc"
        {
            return true;
        }
        accepts_with_extra(
            metadata,
            EXTENDED_LOGGING.load(Ordering::Relaxed),
            &self.extra_targets,
        ) && self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record<'_>) {
        self.log_with_extended(
            record,
            EXTENDED_LOGGING.load(Ordering::Relaxed),
            Instant::now(),
        );
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RateLimitDecision {
    Allow,
    AllowWithSummary { suppressed: u64, elapsed_secs: u64 },
    Drop,
}

#[derive(Debug, PartialEq, Eq)]
struct RateBucketKey {
    target: String,
    level: log::Level,
    signature: String,
}

struct RateBucket {
    key: RateBucketKey,
    window_start: Instant,
    count: u32,
    suppressed: u64,
}

struct RateLimiter {
    buckets: VecDeque<RateBucket>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            buckets: VecDeque::with_capacity(RATE_LIMIT_BUCKETS),
        }
    }

    fn check(
        &mut self,
        target: &str,
        level: log::Level,
        message: &str,
        now: Instant,
    ) -> RateLimitDecision {
        let signature = normalize_signature(message);
        if let Some(pos) = self.buckets.iter().position(|bucket| {
            bucket.key.level == level
                && bucket.key.target == target
                && bucket.key.signature == signature
        }) {
            let mut bucket = self.buckets.remove(pos).expect("index is in bounds");
            let decision = if now.duration_since(bucket.window_start) >= RATE_LIMIT_WINDOW {
                let elapsed_secs = now.duration_since(bucket.window_start).as_secs().max(1);
                let suppressed = bucket.suppressed;
                bucket.window_start = now;
                bucket.count = 1;
                bucket.suppressed = 0;
                if suppressed > 0 {
                    RateLimitDecision::AllowWithSummary {
                        suppressed,
                        elapsed_secs,
                    }
                } else {
                    RateLimitDecision::Allow
                }
            } else if bucket.count < RATE_LIMIT_BURST {
                bucket.count += 1;
                RateLimitDecision::Allow
            } else {
                bucket.suppressed += 1;
                RateLimitDecision::Drop
            };
            self.buckets.push_back(bucket);
            return decision;
        }

        if self.buckets.len() >= RATE_LIMIT_BUCKETS {
            self.buckets.pop_front();
        }
        self.buckets.push_back(RateBucket {
            key: RateBucketKey {
                target: target.to_owned(),
                level,
                signature,
            },
            window_start: now,
            count: 1,
            suppressed: 0,
        });
        RateLimitDecision::Allow
    }

    fn drain_expired(&mut self, now: Instant) -> Vec<(String, log::Level, String, u64, u64)> {
        let mut summaries = Vec::new();
        for bucket in &mut self.buckets {
            if bucket.suppressed > 0 && now.duration_since(bucket.window_start) >= RATE_LIMIT_WINDOW
            {
                let elapsed_secs = now.duration_since(bucket.window_start).as_secs().max(1);
                summaries.push((
                    bucket.key.target.clone(),
                    bucket.key.level,
                    bucket.key.signature.clone(),
                    bucket.suppressed,
                    elapsed_secs,
                ));
                bucket.window_start = now;
                bucket.count = 0;
                bucket.suppressed = 0;
            }
        }
        summaries
    }
}

/// Normalizes a message into a short bucket signature (~96 bytes) by replacing
/// UUIDs, hex literals/hashes, and digit sequences with `#`.
fn normalize_signature(message: &str) -> String {
    let bytes = message.as_bytes();
    let mut out = String::with_capacity(SIGNATURE_MAX_BYTES.min(message.len()));
    let mut index = 0;
    let push_hash = |out: &mut String| {
        if !out.ends_with('#') && out.len() < SIGNATURE_MAX_BYTES {
            out.push('#');
        }
    };

    while index < bytes.len() && out.len() < SIGNATURE_MAX_BYTES {
        if is_uuid_at(bytes, index) {
            push_hash(&mut out);
            index += 36;
            continue;
        }
        if bytes[index] == b'0'
            && index + 2 < bytes.len()
            && matches!(bytes[index + 1], b'x' | b'X')
            && bytes[index + 2].is_ascii_hexdigit()
        {
            push_hash(&mut out);
            index += 2;
            while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
                index += 1;
            }
            continue;
        }
        if let Some(hex_len) = long_hex_token_len(bytes, index) {
            push_hash(&mut out);
            index += hex_len;
            continue;
        }
        if bytes[index].is_ascii_digit() {
            push_hash(&mut out);
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            continue;
        }
        let ch = message[index..].chars().next().unwrap();
        let normalized = if ch == '\r' || ch == '\n' { ' ' } else { ch };
        let ch_len = normalized.len_utf8();
        if out.len() + ch_len > SIGNATURE_MAX_BYTES {
            break;
        }
        if normalized != '#' || !out.ends_with('#') {
            out.push(normalized);
        }
        index += ch.len_utf8();
    }
    out
}

fn is_uuid_at(bytes: &[u8], start: usize) -> bool {
    if start + 36 > bytes.len() {
        return false;
    }
    if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
        return false;
    }
    if start + 36 < bytes.len() && bytes[start + 36].is_ascii_alphanumeric() {
        return false;
    }
    for offset in 0..36 {
        let b = bytes[start + offset];
        if matches!(offset, 8 | 13 | 18 | 23) {
            if b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn long_hex_token_len(bytes: &[u8], start: usize) -> Option<usize> {
    if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
        return None;
    }
    let mut end = start;
    let mut has_digit = false;
    while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
        has_digit |= bytes[end].is_ascii_digit();
        end += 1;
    }
    let len = end - start;
    if len >= 8 && has_digit && (end == bytes.len() || !bytes[end].is_ascii_alphanumeric()) {
        Some(len)
    } else {
        None
    }
}

struct FlightRecorder {
    events: VecDeque<String>,
    last_dump: Option<Instant>,
}

impl FlightRecorder {
    fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(FLIGHT_CAPACITY),
            last_dump: None,
        }
    }

    fn record(&mut self, category: &'static str, message: &str) {
        let redacted = redact(message);
        let single_line = sanitize_and_truncate(&redacted, FLIGHT_MAX_MSG_BYTES);
        let entry = format!(
            "{} [{category}] {single_line}",
            jiff::ZonedDateTime::now().strftime("%Y-%m-%d %H:%M:%S%.3f")
        );
        if self.events.len() >= FLIGHT_CAPACITY {
            self.events.pop_front();
        }
        self.events.push_back(entry);
    }

    fn prepare_dump(&mut self, force: bool, now: Instant) -> Option<Vec<String>> {
        if !force
            && self
                .last_dump
                .is_some_and(|prev| now.duration_since(prev) < FLIGHT_DUMP_COOLDOWN)
        {
            return None;
        }
        self.last_dump = Some(now);
        Some(self.events.iter().cloned().collect())
    }

    fn recent(&self) -> Vec<String> {
        self.events.iter().cloned().collect()
    }
}

fn sanitize_and_truncate(text: &str, max_bytes: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_bytes));
    for ch in text.chars() {
        let ch = if ch == '\r' || ch == '\n' { ' ' } else { ch };
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

/// The last lines of the application log, oldest first. Reaches into the
/// newest rotated file when the active one was only just started.
pub async fn tail(logs_dir: &Path) -> Vec<String> {
    let current = logs_dir.join(format!("{FILE_NAME}.log"));
    let mut text = read_tail(&current, TAIL_BYTES).await.unwrap_or_default();
    let remaining = TAIL_BYTES.saturating_sub(text.len() as u64);
    if remaining > 0
        && let Some(archived) = newest_archive(logs_dir).await
    {
        let older = read_tail(&archived, remaining).await.unwrap_or_default();
        text = older + &text;
    }
    redact(&text)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

async fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let start = file.metadata().await?.len().saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).await?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // Starting mid-file cuts the first line; drop it rather than show half.
    Ok(if start > 0 {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_owned())
            .unwrap_or_default()
    } else {
        text
    })
}

/// Rotated files are named `ftpeach-app_<date>.log` with a sortable date.
async fn newest_archive(logs_dir: &Path) -> Option<PathBuf> {
    let prefix = format!("{FILE_NAME}_");
    let mut entries = tokio::fs::read_dir(logs_dir).await.ok()?;
    let mut newest: Option<String> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix)
            && name.ends_with(".log")
            && newest.as_ref().is_none_or(|current| name > *current)
        {
            newest = Some(name);
        }
    }
    newest.map(|name| logs_dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_logging_allows_app_lib_and_ipc_debug_and_excludes_dependency_debug_logs() {
        for (target, level, enabled, expected) in [
            (
                "app_lib::runtime::shutdown",
                log::Level::Debug,
                false,
                false,
            ),
            ("app_lib::runtime::shutdown", log::Level::Debug, true, true),
            ("app_lib::protocol::ftp", log::Level::Debug, true, true),
            ("app_lib::transfer::pool", log::Level::Debug, true, true),
            ("app_lib::commands::log", log::Level::Debug, true, true),
            ("webview::ipc", log::Level::Debug, true, true),
            ("webview::ipc", log::Level::Debug, false, false),
            ("app_lib::runtime::shutdown", log::Level::Trace, true, false),
            ("ssh2", log::Level::Debug, true, false),
            ("russh", log::Level::Debug, true, false),
            ("app_lib::runtime::tray", log::Level::Warn, false, true),
        ] {
            let metadata = log::Metadata::builder().target(target).level(level).build();
            assert_eq!(
                accepts_with_extra(&metadata, enabled, &[]),
                expected,
                "{target} {level} enabled={enabled}"
            );
        }

        let extra = vec!["russh".to_string()];
        let russh_meta = log::Metadata::builder()
            .target("russh::client")
            .level(log::Level::Debug)
            .build();
        assert!(accepts_with_extra(&russh_meta, false, &extra));
        let russh_trace = log::Metadata::builder()
            .target("russh::client")
            .level(log::Level::Trace)
            .build();
        assert!(!accepts_with_extra(&russh_trace, true, &extra));
    }

    #[test]
    fn rate_limiter_allows_burst_suppresses_flood_and_reports_summary() {
        let mut limiter = RateLimiter::new();
        let t0 = Instant::now();

        for i in 1..=5 {
            assert_eq!(
                limiter.check(
                    "app_lib::protocol::ftp",
                    log::Level::Warn,
                    &format!("retry #{i} for 550e8400-e29b-41d4-a716-44665544000{i}"),
                    t0,
                ),
                RateLimitDecision::Allow
            );
        }
        for i in 6..=20 {
            assert_eq!(
                limiter.check(
                    "app_lib::protocol::ftp",
                    log::Level::Warn,
                    &format!("retry #{i} for 123e4567-e89b-12d3-a456-4266141740{i:02}"),
                    t0 + Duration::from_secs(2),
                ),
                RateLimitDecision::Drop
            );
        }

        assert_eq!(
            limiter.check(
                "app_lib::protocol::ftp",
                log::Level::Warn,
                "retry #21 for 00000000-0000-0000-0000-000000000001",
                t0 + Duration::from_secs(11),
            ),
            RateLimitDecision::AllowWithSummary {
                suppressed: 15,
                elapsed_secs: 11,
            }
        );
    }

    #[test]
    fn rate_limiter_bounds_bucket_count_and_drains_expired_summaries() {
        let mut limiter = RateLimiter::new();
        let t0 = Instant::now();
        for i in 0..(RATE_LIMIT_BUCKETS + 10) {
            limiter.check(
                "app_lib::test",
                log::Level::Info,
                &format!(
                    "bucket-{}{}",
                    (b'a' + (i / 26) as u8) as char,
                    (b'a' + (i % 26) as u8) as char
                ),
                t0,
            );
        }
        assert_eq!(limiter.buckets.len(), RATE_LIMIT_BUCKETS);

        for _ in 0..8 {
            limiter.check("app_lib::test", log::Level::Warn, "flood line", t0);
        }
        let expired = limiter.drain_expired(t0 + Duration::from_secs(10));
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].3, 3);
        assert!(
            limiter
                .drain_expired(t0 + Duration::from_secs(20))
                .is_empty()
        );
    }

    #[test]
    fn normalize_signature_groups_numbers_hex_and_uuids() {
        assert_eq!(
            normalize_signature(
                "retry #1 at 120,450 req 550e8400-e29b-41d4-a716-446655440000 0xdeadbeef"
            ),
            normalize_signature(
                "retry #99 at 800,600 req 123e4567-e89b-12d3-a456-426614174000 0x1234abcd"
            )
        );
        assert!(normalize_signature(&"a".repeat(300)).len() <= SIGNATURE_MAX_BYTES);
    }

    #[test]
    fn suppressed_records_write_zero_bytes_and_no_empty_lines_to_file() {
        struct FileLogger {
            path: PathBuf,
        }
        impl log::Log for FileLogger {
            fn enabled(&self, _: &log::Metadata<'_>) -> bool {
                true
            }
            fn log(&self, record: &log::Record<'_>) {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                    .unwrap();
                writeln!(file, "{}", record.args()).unwrap();
            }
            fn flush(&self) {}
        }

        let dir = std::env::temp_dir().join(format!("ftpeach-rate-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("out.log");
        let logger = AppLogger::new_for_test(
            Box::new(FileLogger {
                path: file_path.clone(),
            }),
            Arc::new(Mutex::new(RateLimiter::new())),
            Vec::new(),
        );

        let t0 = Instant::now();
        for i in 1..=20 {
            let msg = format!("repeated error #{i}");
            let mut builder = log::Record::builder();
            builder
                .level(log::Level::Warn)
                .target("app_lib::runtime::test");
            logger.log_with_extended(&builder.args(format_args!("{msg}")).build(), false, t0);
        }

        let contents = std::fs::read_to_string(&file_path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), RATE_LIMIT_BURST as usize);
        assert!(lines.iter().all(|line| !line.trim().is_empty()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn flight_recorder_caps_capacity_redacts_and_enforces_dump_cooldown() {
        let mut recorder = FlightRecorder::new();
        for i in 0..250 {
            recorder.record("lifecycle", &format!("event {i} password=secret-{i}"));
        }
        let recent = recorder.recent();
        assert_eq!(recent.len(), FLIGHT_CAPACITY);
        assert!(recent.first().unwrap().contains("event 50"));
        assert!(recent.last().unwrap().contains("event 249"));
        assert!(recent.iter().all(|line| !line.contains("secret-")));
        assert!(recent.iter().all(|line| line.contains("[REDACTED]")));

        let t0 = Instant::now();
        assert_eq!(
            recorder.prepare_dump(false, t0).unwrap().len(),
            FLIGHT_CAPACITY
        );
        assert!(
            recorder
                .prepare_dump(false, t0 + Duration::from_secs(30))
                .is_none()
        );
        assert_eq!(
            recorder
                .prepare_dump(true, t0 + Duration::from_secs(30))
                .unwrap()
                .len(),
            FLIGHT_CAPACITY
        );
        assert_eq!(
            recorder
                .prepare_dump(false, t0 + Duration::from_secs(91))
                .unwrap()
                .len(),
            FLIGHT_CAPACITY
        );
    }

    #[tokio::test]
    async fn tail_reads_the_newest_lines_across_a_rotation_and_redacts_them() {
        let dir = std::env::temp_dir().join(format!("ftpeach-app-log-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join("ftpeach-app_2026-09-10_08-00-00.log"),
            "older archive\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            dir.join("ftpeach-app_2026-09-11_08-00-00.log"),
            "archived line\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            dir.join("ftpeach-app.log"),
            "first line\npassword=hunter2\n",
        )
        .await
        .unwrap();

        assert_eq!(
            tail(&dir).await,
            vec!["archived line", "first line", "password=[REDACTED]"]
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn a_tail_cut_mid_file_starts_at_a_whole_line() {
        let dir = std::env::temp_dir().join(format!("ftpeach-app-log-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("log.log");
        tokio::fs::write(&path, "0123456789\nabc\n").await.unwrap();
        assert_eq!(read_tail(&path, 8).await.unwrap(), "abc\n");
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn resolve_extended_logging_handles_active_expired_and_legacy_migration() {
        let now_ms = 1_750_000_000_000_i64;
        let map =
            |v: serde_json::Value| serde_json::from_value::<crate::store::JsonMap>(v).unwrap();

        assert_eq!(
            resolve_extended_logging(
                &map(serde_json::json!({ "extendedLogging": false })),
                now_ms
            ),
            ExtendedResolution::Disabled
        );
        assert_eq!(
            resolve_extended_logging(
                &map(serde_json::json!({
                    "extendedLogging": true,
                    "extendedLoggingUntil": now_ms + 60_000
                })),
                now_ms
            ),
            ExtendedResolution::Active {
                until_ms: now_ms + 60_000
            }
        );
        assert_eq!(
            resolve_extended_logging(
                &map(serde_json::json!({
                    "extendedLogging": true,
                    "extendedLoggingUntil": now_ms
                })),
                now_ms
            ),
            ExtendedResolution::Expired
        );
        assert_eq!(
            resolve_extended_logging(
                &map(serde_json::json!({
                    "extendedLogging": true,
                    "extendedLoggingUntil": now_ms - 1
                })),
                now_ms
            ),
            ExtendedResolution::Expired
        );
        assert_eq!(
            resolve_extended_logging(&map(serde_json::json!({ "extendedLogging": true })), now_ms),
            ExtendedResolution::MigrateFreshDeadline {
                until_ms: now_ms + EXTENDED_TTL_MS
            }
        );
        assert_eq!(
            resolve_extended_logging(
                &map(serde_json::json!({
                    "extendedLogging": true,
                    "extendedLoggingUntil": null
                })),
                now_ms
            ),
            ExtendedResolution::MigrateFreshDeadline {
                until_ms: now_ms + EXTENDED_TTL_MS
            }
        );
    }

    #[tokio::test]
    async fn extended_logging_ttl_persists_migration_and_expiration() {
        let dir = std::env::temp_dir().join(format!("ftpeach-ttl-{}", uuid::Uuid::new_v4()));
        let store = crate::store::Store::new_at(dir.clone());

        // Legacy setting without deadline gets a fresh 24h window.
        let mut legacy = crate::store::JsonMap::new();
        legacy.insert("extendedLogging".into(), serde_json::Value::Bool(true));
        store.set_settings(legacy).await.unwrap();
        let fresh_until = now_epoch_ms() + EXTENDED_TTL_MS;
        persist_extended_migration(&store, fresh_until).await;
        let migrated = store.get_settings().await;
        assert_eq!(
            migrated.get("extendedLogging"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            migrated
                .get("extendedLoggingUntil")
                .and_then(serde_json::Value::as_i64),
            Some(fresh_until)
        );

        // Expired deadline turns extendedLogging off and clears extendedLoggingUntil.
        let mut expired = crate::store::JsonMap::new();
        expired.insert("extendedLogging".into(), serde_json::Value::Bool(true));
        expired.insert("extendedLoggingUntil".into(), serde_json::json!(1_000));
        store.set_settings(expired).await.unwrap();
        persist_extended_expired(&store, None).await;
        let reset = store.get_settings().await;
        assert_eq!(
            reset.get("extendedLogging"),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            reset.get("extendedLoggingUntil"),
            Some(&serde_json::Value::Null)
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
