//! The protocol log: every line a backend reports.
//!
//! Recording does not depend on the log panel. The last [`RECENT_CAPACITY`]
//! records always stay in memory, so opening the panel after an error still
//! shows how it came about, a reloaded WebView gets its history back, and a
//! diagnostic bundle is built here rather than from whatever the renderer kept.
//!
//! One writer task receives records in order through a channel, gathers them
//! for [`FLUSH_INTERVAL`], sends each batch to the panel and, when the user has
//! turned it on, appends it to a daily file. Being the only writer is what keeps
//! batches in order in the file and in the panel alike.

use crate::protocol::{LogKind, LogText};
use crate::runtime::diagnostics::redact;
use crate::runtime::log_messages;
use chrono::{DateTime, Local, NaiveDate};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

/// How many records stay in memory for the panel and the diagnostic bundle.
pub const RECENT_CAPACITY: usize = 5_000;
const FLUSH_INTERVAL: Duration = Duration::from_millis(150);
const MAX_LOG_AGE: Duration = Duration::from_secs(14 * 86_400);
/// A day's file continues in `ftpeach-<date>_2.log` and so on past this size.
const MAX_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// The oldest files go once all of them together pass this size.
const MAX_LOG_DIR_BYTES: u64 = 50 * 1024 * 1024;
const LOG_FILE_PREFIX: &str = "ftpeach-";
const LOG_FILE_SUFFIX: &str = ".log";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    /// Increases by one per record across all connections, so a reader that
    /// combines `log_recent` with live batches can drop what it already has.
    pub seq: u64,
    pub ts: i64,
    pub kind: LogKind,
    pub connection_id: String,
    /// The server as the log names it, for a connection the renderer no
    /// longer has a label for.
    pub server: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl LogRecord {
    /// The line as someone outside the app reads it: raw protocol text as is,
    /// translated events in English.
    fn text(&self) -> String {
        match (&self.line, &self.key) {
            (Some(line), _) => line.clone(),
            (None, Some(key)) => log_messages::render(
                key,
                self.params.as_ref().unwrap_or(&serde_json::Value::Null),
            ),
            (None, None) => String::new(),
        }
    }

    /// Server and the start of the connection id: two panes on the same
    /// server stay apart, and the id is still short enough to read.
    fn origin(&self) -> String {
        let short_id: String = self.connection_id.chars().take(8).collect();
        if self.server.is_empty() {
            short_id
        } else {
            format!("{} {short_id}", self.server)
        }
    }
}

struct Recent {
    records: VecDeque<LogRecord>,
    next_seq: u64,
    writer: mpsc::UnboundedSender<LogRecord>,
}

#[derive(Clone)]
pub struct LogEmitter {
    recent: Arc<Mutex<Recent>>,
    file_logging: Arc<AtomicBool>,
    date_format: Arc<Mutex<String>>,
}

impl LogEmitter {
    /// Starts the writer task. `publish` receives each batch in order; the
    /// app hands it to the panel as the `protocol:log` event.
    pub fn start(log_dir: PathBuf, publish: impl Fn(&[LogRecord]) + Send + 'static) -> Self {
        let (writer, receiver) = mpsc::unbounded_channel();
        let emitter = Self {
            recent: Arc::new(Mutex::new(Recent {
                records: VecDeque::new(),
                next_seq: 1,
                writer,
            })),
            file_logging: Arc::new(AtomicBool::new(false)),
            date_format: Arc::new(Mutex::new("locale".to_string())),
        };
        tauri::async_runtime::spawn(run_writer(
            receiver,
            LogFiles::new(log_dir),
            emitter.file_logging.clone(),
            emitter.date_format.clone(),
            publish,
        ));
        emitter
    }

    pub fn set_file_logging_enabled(&self, enabled: bool) {
        self.file_logging.store(enabled, Ordering::Relaxed);
    }

    pub fn set_date_format(&self, date_format: &str) {
        *self.date_format.lock().unwrap() = date_format.to_string();
    }

    pub fn push(&self, text: LogText, kind: LogKind, connection_id: &str, server: &str) {
        let (line, key, params) = match text {
            LogText::Raw(s) => (Some(redact(&s)), None, None),
            LogText::Key { key, params } => (None, Some(key.to_string()), Some(params)),
        };
        // Numbering, keeping and queueing under one lock: records reach the
        // writer in the order of their numbers.
        let mut recent = self.recent.lock().unwrap();
        let record = LogRecord {
            seq: recent.next_seq,
            ts: chrono::Utc::now().timestamp_millis(),
            kind,
            connection_id: connection_id.to_string(),
            server: server.to_string(),
            line,
            key,
            params,
        };
        recent.next_seq += 1;
        if recent.records.len() == RECENT_CAPACITY {
            recent.records.pop_front();
        }
        recent.records.push_back(record.clone());
        let _ = recent.writer.send(record);
    }

    /// Everything still in memory, oldest first.
    pub fn recent(&self) -> Vec<LogRecord> {
        self.recent
            .lock()
            .unwrap()
            .records
            .iter()
            .cloned()
            .collect()
    }

    /// The records in memory in the diagnostic bundle's shape: English text,
    /// local time with milliseconds, and the server instead of an opaque id.
    pub fn diagnostic_records(&self) -> Vec<serde_json::Value> {
        self.recent()
            .iter()
            .map(|record| {
                serde_json::json!({
                    "time": local_time(record.ts)
                        .map(|time| time.format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string()),
                    "kind": record.kind,
                    "server": record.server,
                    "connection": record.origin(),
                    "text": redact(&record.text()),
                })
            })
            .collect()
    }
}

async fn run_writer(
    mut receiver: mpsc::UnboundedReceiver<LogRecord>,
    mut files: LogFiles,
    file_logging: Arc<AtomicBool>,
    date_format: Arc<Mutex<String>>,
    publish: impl Fn(&[LogRecord]),
) {
    // Once per start, whether or not file logging is on, so files left from
    // an earlier session still age out.
    files.cleanup(None).await;
    while let Some(first) = receiver.recv().await {
        let mut batch = vec![first];
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                () = &mut deadline => break,
                next = receiver.recv() => match next {
                    Some(record) => batch.push(record),
                    None => break,
                },
            }
        }
        publish(&batch);
        if file_logging.load(Ordering::Relaxed) {
            let preference = date_format.lock().unwrap().clone();
            files.append(&batch, &preference).await;
        } else {
            files.close();
        }
    }
}

struct OpenLog {
    date: NaiveDate,
    part: u32,
    path: PathBuf,
    file: tokio::fs::File,
    size: u64,
}

/// The daily files, owned by the writer task alone. The current file stays
/// open between batches; directory work happens only when a file is opened —
/// on the first write, on a new day and when a file fills up.
struct LogFiles {
    dir: PathBuf,
    open: Option<OpenLog>,
}

impl LogFiles {
    fn new(dir: PathBuf) -> Self {
        Self { dir, open: None }
    }

    fn close(&mut self) {
        self.open = None;
    }

    async fn append(&mut self, batch: &[LogRecord], preference: &str) {
        // Consecutive records of the same day go out in one write.
        let mut pending: Option<(NaiveDate, String)> = None;
        for record in batch {
            let Some(time) = local_time(record.ts) else {
                continue;
            };
            let date = time.date_naive();
            if let Some((pending_date, text)) = pending.take_if(|(day, _)| *day != date) {
                self.write(pending_date, &text).await;
            }
            pending
                .get_or_insert_with(|| (date, String::new()))
                .1
                .push_str(&format_log_line(record, &time, preference));
        }
        if let Some((date, text)) = pending {
            self.write(date, &text).await;
        }
    }

    async fn write(&mut self, date: NaiveDate, text: &str) {
        let length = text.len() as u64;
        let next_part = match &self.open {
            Some(open) if open.date == date => {
                (open.size > 0 && open.size + length > MAX_LOG_FILE_BYTES).then_some(open.part + 1)
            }
            _ => Some(1),
        };
        if let Some(part) = next_part
            && let Err(error) = self.open_file(date, part).await
        {
            log::warn!("Could not open the protocol log file: {error}");
            self.open = None;
            return;
        }
        let Some(open) = self.open.as_mut() else {
            return;
        };
        let written = async {
            open.file.write_all(text.as_bytes()).await?;
            open.file.flush().await
        }
        .await;
        match written {
            Ok(()) => open.size += length,
            Err(error) => {
                log::warn!("Could not write the protocol log file: {error}");
                // Reopened, and the directory checked again, on the next batch.
                self.open = None;
            }
        }
    }

    /// Opens the file for `date`, at `part` or at the newest part already on
    /// disk if that is later — a restart during the day carries on where the
    /// last session stopped — skipping parts that are already full.
    async fn open_file(&mut self, date: NaiveDate, part: u32) -> std::io::Result<()> {
        self.open = None;
        tokio::fs::create_dir_all(&self.dir).await?;
        let mut part = part;
        while tokio::fs::try_exists(self.dir.join(log_file_name(date, part + 1)))
            .await
            .unwrap_or(false)
        {
            part += 1;
        }
        loop {
            let path = self.dir.join(log_file_name(date, part));
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .await?;
            let size = file.metadata().await?.len();
            if size < MAX_LOG_FILE_BYTES {
                self.cleanup(Some(&path)).await;
                self.open = Some(OpenLog {
                    date,
                    part,
                    path,
                    file,
                    size,
                });
                return Ok(());
            }
            part += 1;
        }
    }

    /// Removes files past their age, then the oldest ones until the rest fit
    /// the size budget. Never the file about to be written.
    async fn cleanup(&self, keep: Option<&Path>) {
        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        let mut files = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            if !is_protocol_log_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let Ok(metadata) = entry.metadata().await else {
                continue;
            };
            files.push(LogFileInfo {
                path: entry.path(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                size: metadata.len(),
            });
        }
        let current = self.open.as_ref().map(|open| open.path.as_path());
        for path in files_to_remove(files, SystemTime::now(), keep.or(current)) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

struct LogFileInfo {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

fn files_to_remove(
    mut files: Vec<LogFileInfo>,
    now: SystemTime,
    keep: Option<&Path>,
) -> Vec<PathBuf> {
    let cutoff = now.checked_sub(MAX_LOG_AGE);
    // Newest first; the kept file counts first so the budget makes room for it.
    files.sort_by_key(|file| {
        (
            Some(file.path.as_path()) != keep,
            std::cmp::Reverse(file.modified),
        )
    });
    let mut total = 0u64;
    files
        .into_iter()
        .filter_map(|file| {
            if Some(file.path.as_path()) == keep {
                total += file.size;
                return None;
            }
            let too_old = cutoff.is_some_and(|cutoff| file.modified < cutoff);
            total += file.size;
            (too_old || total > MAX_LOG_DIR_BYTES).then_some(file.path)
        })
        .collect()
}

/// `ftpeach-` followed by a date: today's ISO names and the older ones that
/// followed the date-format setting, but not `ftpeach-app.log` beside them.
fn is_protocol_log_name(name: &str) -> bool {
    name.strip_prefix(LOG_FILE_PREFIX)
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        && name.ends_with(LOG_FILE_SUFFIX)
}

fn local_time(timestamp_millis: i64) -> Option<DateTime<Local>> {
    DateTime::from_timestamp_millis(timestamp_millis).map(|time| time.with_timezone(&Local))
}

/// Always ISO, whatever the date-format setting: the files sort by date, and
/// changing the setting during the day does not split the day in two.
fn log_file_name(date: NaiveDate, part: u32) -> String {
    let date = date.format("%Y-%m-%d");
    if part <= 1 {
        format!("{LOG_FILE_PREFIX}{date}{LOG_FILE_SUFFIX}")
    } else {
        format!("{LOG_FILE_PREFIX}{date}_{part}{LOG_FILE_SUFFIX}")
    }
}

fn selected_date_pattern(preference: &str) -> &'static str {
    let date = preference
        .split_once(' ')
        .map_or(preference, |(date, _)| date);
    match date {
        "dd/MM/yyyy" => "%d/%m/%Y",
        "dd-MM-yyyy" => "%d-%m-%Y",
        "dd.MM.yyyy" => "%d.%m.%Y",
        "MM/dd/yyyy" => "%m/%d/%Y",
        "MM-dd-yyyy" => "%m-%d-%Y",
        "yyyy/MM/dd" => "%Y/%m/%d",
        _ => "%Y-%m-%d",
    }
}

fn format_log_line(record: &LogRecord, local_time: &DateTime<Local>, preference: &str) -> String {
    let time_pattern = if preference.ends_with("hh:mm a") {
        "%I:%M:%S%.3f %p"
    } else {
        "%H:%M:%S%.3f"
    };
    format!(
        "{} {} [{}] {:?}: {}\n",
        local_time.format(selected_date_pattern(preference)),
        local_time.format(time_pattern),
        record.origin(),
        record.kind,
        record.text()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(seq: u64, text: LogText) -> LogRecord {
        let (line, key, params) = match text {
            LogText::Raw(line) => (Some(line), None, None),
            LogText::Key { key, params } => (None, Some(key.to_string()), Some(params)),
        };
        LogRecord {
            seq,
            ts: 1_725_025_845_123,
            kind: LogKind::Status,
            connection_id: "3f2a9c1e-7b7d-4c55-9d4e-0f6a2b1c8d90".to_string(),
            server: "ftp://example.test:21".to_string(),
            line,
            key,
            params,
        }
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("ftpeach-protocol-log-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn file_names_are_iso_dates_whatever_the_date_format() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 11).unwrap();
        assert_eq!(log_file_name(date, 1), "ftpeach-2026-09-11.log");
        assert_eq!(log_file_name(date, 3), "ftpeach-2026-09-11_3.log");
        assert!(is_protocol_log_name("ftpeach-2026-09-11_3.log"));
        assert!(is_protocol_log_name("ftpeach-11.09.2026.log"));
        assert!(!is_protocol_log_name("ftpeach-app.log"));
        assert!(!is_protocol_log_name("ftpeach-app_2026-09-11_08-00-00.log"));
    }

    #[test]
    fn log_line_names_the_server_and_writes_events_in_english() {
        let time = local_time(1_725_025_845_123).unwrap();
        let line = format_log_line(
            &record(
                1,
                LogText::event(
                    "connecting",
                    serde_json::json!({ "addr": "example.test:21" }),
                ),
            ),
            &time,
            "dd.MM.yyyy hh:mm a",
        );
        assert!(line.starts_with(&time.format("%d.%m.%Y %I:%M:%S%.3f %p").to_string()));
        assert!(line.contains("[ftp://example.test:21 3f2a9c1e] Status: "));
        assert!(line.ends_with("Connecting to example.test:21...\n"));
    }

    #[test]
    fn cleanup_removes_old_files_and_the_oldest_past_the_size_budget() {
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        let file = |name: &str, age_days: u32, size: u64| LogFileInfo {
            path: PathBuf::from(name),
            modified: now - day * age_days,
            size,
        };
        let removed = files_to_remove(
            vec![
                file("stale", 15, 1),
                file("newest", 0, MAX_LOG_DIR_BYTES / 2),
                file("older", 2, MAX_LOG_DIR_BYTES / 2),
                file("oldest", 3, 1),
                file("current", 1, 1),
            ],
            now,
            Some(Path::new("current")),
        );
        assert_eq!(
            removed,
            vec![
                PathBuf::from("older"),
                PathBuf::from("oldest"),
                PathBuf::from("stale")
            ]
        );
    }

    #[tokio::test]
    async fn a_full_file_continues_in_the_next_part() {
        let dir = temp_dir();
        let date = NaiveDate::from_ymd_opt(2026, 9, 11).unwrap();
        let mut files = LogFiles::new(dir.clone());
        files.write(date, "first\n").await;
        files.open.as_mut().unwrap().size = MAX_LOG_FILE_BYTES;
        files.write(date, "second\n").await;
        assert_eq!(files.open.as_ref().unwrap().part, 2);
        files.close();

        // A restart the same day appends to the newest part.
        let mut restarted = LogFiles::new(dir.clone());
        restarted.write(date, "third\n").await;
        restarted.close();
        assert_eq!(
            tokio::fs::read_to_string(dir.join("ftpeach-2026-09-11.log"))
                .await
                .unwrap(),
            "first\n"
        );
        assert_eq!(
            tokio::fs::read_to_string(dir.join("ftpeach-2026-09-11_2.log"))
                .await
                .unwrap(),
            "second\nthird\n"
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn records_stay_in_memory_and_reach_the_panel_in_order() {
        let (sender, mut batches) = mpsc::unbounded_channel();
        let emitter = LogEmitter::start(temp_dir(), move |batch: &[LogRecord]| {
            let _ = sender.send(batch.iter().map(|record| record.seq).collect::<Vec<_>>());
        });
        for index in 0..(RECENT_CAPACITY + 10) {
            emitter.push(
                LogText::Raw(format!("line {index} password=hunter2")),
                LogKind::Command,
                "connection",
                "ftp://example.test:21",
            );
        }

        let recent = emitter.recent();
        assert_eq!(recent.len(), RECENT_CAPACITY);
        assert_eq!(recent.first().unwrap().seq, 11);
        assert_eq!(recent.last().unwrap().seq, (RECENT_CAPACITY + 10) as u64);
        assert!(recent.iter().all(|record| {
            record
                .line
                .as_deref()
                .is_some_and(|line| line.ends_with("password=[REDACTED]"))
        }));

        let mut received = Vec::new();
        while received.len() < RECENT_CAPACITY + 10 {
            received.extend(batches.recv().await.unwrap());
        }
        assert!(received.windows(2).all(|pair| pair[1] == pair[0] + 1));
    }

    #[test]
    fn diagnostic_records_carry_english_text_and_the_server() {
        let (writer, _receiver) = mpsc::unbounded_channel();
        let emitter = LogEmitter {
            recent: Arc::new(Mutex::new(Recent {
                records: VecDeque::from([record(
                    1,
                    LogText::event("receivedEntries", serde_json::json!({ "count": 2 })),
                )]),
                next_seq: 2,
                writer,
            })),
            file_logging: Arc::default(),
            date_format: Arc::default(),
        };
        let records = emitter.diagnostic_records();
        assert_eq!(records[0]["text"], "Received 2 entries");
        assert_eq!(records[0]["server"], "ftp://example.test:21");
        assert_eq!(records[0]["kind"], "status");
        assert_eq!(records[0]["connection"], "ftp://example.test:21 3f2a9c1e");
    }
}
