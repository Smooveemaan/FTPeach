use crate::protocol::{LogKind, LogText};
use crate::runtime::diagnostics::redact;
use chrono::{DateTime, Local};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

/// Whether protocol logging is on. A process-wide flag rather than a command
/// module's state: the connect pipeline reads it when building a backend, and
/// the log commands write it.
#[derive(Default)]
pub struct LogState {
    pub enabled: Arc<AtomicBool>,
}

const FLUSH_INTERVAL_MS: u64 = 150;
const MAX_LOG_AGE_DAYS: i64 = 14;
const LOG_FILE_PREFIX: &str = "ftpeach-";
const LOG_FILE_SUFFIX: &str = ".log";

#[derive(Serialize, Clone)]
struct LogLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
    kind: LogKind,
    ts: i64,
    #[serde(rename = "connectionId")]
    connection_id: String,
}

#[derive(Clone)]
pub struct LogEmitter {
    app: AppHandle,
    buffer: Arc<Mutex<Vec<LogLine>>>,
    flush_scheduled: Arc<AtomicBool>,
    log_dir: PathBuf,
    file_logging: Arc<AtomicBool>,
    date_format: Arc<Mutex<String>>,
}

impl LogEmitter {
    pub fn new(app: AppHandle, log_dir: PathBuf) -> Self {
        Self {
            app,
            buffer: Arc::new(Mutex::new(Vec::new())),
            flush_scheduled: Arc::new(AtomicBool::new(false)),
            log_dir,
            file_logging: Arc::new(AtomicBool::new(false)),
            date_format: Arc::new(Mutex::new("locale".to_string())),
        }
    }

    pub fn set_file_logging_enabled(&self, enabled: bool) {
        self.file_logging.store(enabled, Ordering::Relaxed);
    }

    pub fn set_date_format(&self, date_format: &str) {
        *self.date_format.lock().unwrap() = date_format.to_string();
    }

    pub fn push(&self, text: LogText, kind: LogKind, connection_id: String) {
        let (line, key, params) = match text {
            LogText::Raw(s) => (Some(redact(&s)), None, None),
            LogText::Key { key, params } => (None, Some(key.to_string()), Some(params)),
        };
        let entry = LogLine {
            line,
            key,
            params,
            kind,
            ts: chrono::Utc::now().timestamp_millis(),
            connection_id,
        };
        self.buffer.lock().unwrap().push(entry);
        if self.flush_scheduled.swap(true, Ordering::SeqCst) {
            return; // a flush is already scheduled — it'll pick this up
        }
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(FLUSH_INTERVAL_MS)).await;
            this.flush_scheduled.store(false, Ordering::SeqCst);
            let batch: Vec<LogLine> = std::mem::take(&mut *this.buffer.lock().unwrap());
            if batch.is_empty() {
                return;
            }
            if this.file_logging.load(Ordering::Relaxed) {
                this.write_to_file(&batch).await;
            }
            let _ = this.app.emit("protocol:log", batch);
        });
    }

    async fn write_to_file(&self, batch: &[LogLine]) {
        let _ = tokio::fs::create_dir_all(&self.log_dir).await;
        let mut daily_logs: BTreeMap<String, String> = BTreeMap::new();
        let date_format = self.date_format.lock().unwrap().clone();
        for entry in batch {
            let Some(local_time) = local_time(entry.ts) else {
                continue;
            };
            let file_name = daily_log_file_name(&local_time, &date_format);
            daily_logs
                .entry(file_name)
                .or_default()
                .push_str(&format_log_line(entry, &local_time, &date_format));
        }
        self.cleanup_old_logs().await;
        for (file_name, content) in daily_logs {
            let Ok(mut file) = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.log_dir.join(file_name))
                .await
            else {
                continue;
            };
            let _ = file.write_all(content.as_bytes()).await;
        }
    }

    async fn cleanup_old_logs(&self) {
        let cutoff = std::time::SystemTime::now()
            .checked_sub(Duration::from_secs((MAX_LOG_AGE_DAYS as u64) * 86_400));
        let Ok(mut entries) = tokio::fs::read_dir(&self.log_dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(LOG_FILE_PREFIX) || !name.ends_with(LOG_FILE_SUFFIX) {
                continue;
            }
            let is_old = match (
                cutoff,
                entry.metadata().await.ok().and_then(|m| m.modified().ok()),
            ) {
                (Some(cutoff), Some(modified)) => modified < cutoff,
                _ => false,
            };
            if is_old {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

fn local_time(timestamp_millis: i64) -> Option<DateTime<Local>> {
    DateTime::from_timestamp_millis(timestamp_millis).map(|time| time.with_timezone(&Local))
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

fn daily_log_file_name(time: &DateTime<Local>, preference: &str) -> String {
    // Slashes are valid date separators in the UI but not in Windows file names.
    let date = time
        .format(selected_date_pattern(preference))
        .to_string()
        .replace('/', "-");
    format!("{LOG_FILE_PREFIX}{date}{LOG_FILE_SUFFIX}")
}

fn format_log_line(entry: &LogLine, local_time: &DateTime<Local>, preference: &str) -> String {
    let text = match (&entry.line, &entry.key) {
        (Some(line), _) => line.clone(),
        (None, Some(key)) => format!(
            "{key} {}",
            entry.params.as_ref().unwrap_or(&serde_json::Value::Null)
        ),
        (None, None) => String::new(),
    };
    let time_pattern = if preference.ends_with("hh:mm a") {
        "%I:%M:%S%.3f %p"
    } else {
        "%H:%M:%S%.3f"
    };
    let timestamp = format!(
        "{} {}",
        local_time.format(selected_date_pattern(preference)),
        local_time.format(time_pattern)
    );
    format!(
        "{timestamp} [{}] {:?}: {text}\n",
        entry.connection_id, entry.kind
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_file_name_uses_local_date() {
        let time = local_time(1_725_025_845_123).unwrap();
        assert_eq!(
            daily_log_file_name(&time, "yyyy-MM-dd HH:mm"),
            format!("ftpeach-{}.log", time.format("%Y-%m-%d"))
        );
        assert_eq!(
            daily_log_file_name(&time, "dd.MM.yyyy hh:mm a"),
            format!("ftpeach-{}.log", time.format("%d.%m.%Y"))
        );
    }

    #[test]
    fn log_line_uses_local_date_and_time() {
        let time = local_time(1_725_025_845_123).unwrap();
        let entry = LogLine {
            line: Some("connected".to_string()),
            key: None,
            params: None,
            kind: LogKind::Status,
            ts: time.timestamp_millis(),
            connection_id: "connection-1".to_string(),
        };

        let line = format_log_line(&entry, &time, "dd.MM.yyyy hh:mm a");
        assert!(line.starts_with(&time.format("%d.%m.%Y %I:%M:%S%.3f %p").to_string()));
        assert!(line.contains("[connection-1]"));
        assert!(line.ends_with("connected\n"));
    }
}
