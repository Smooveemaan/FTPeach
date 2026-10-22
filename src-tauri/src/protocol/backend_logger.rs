use super::{LogKind, LogText};
use std::sync::{Arc, RwLock};

pub type LogSink = Arc<dyn Fn(LogText, LogKind) + Send + Sync>;

/// Shared, cloneable logging state for protocol backends and their background
/// tasks. There is no on/off switch: the protocol log records whether or not
/// the panel is open, so a line reaches the sink as soon as one is attached.
#[derive(Clone, Default)]
pub struct BackendLogger {
    sink: Arc<RwLock<Option<LogSink>>>,
}

impl BackendLogger {
    /// A line as it is: protocol wire text (commands, numeric-coded server
    /// replies) is never translated, see `LogText`.
    pub fn emit(&self, line: impl Into<LogText>, kind: LogKind) {
        if let Some(sink) = self.sink.read().unwrap().as_ref() {
            sink(line.into(), kind);
        }
    }

    /// A human-authored line the frontend translates: it resolves `key` via
    /// i18next (`log.{key}`) against `params`.
    pub fn event(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.emit(LogText::event(key, params), kind);
    }

    pub fn set_sink(&self, sink: Option<LogSink>) {
        *self.sink.write().unwrap() = sink;
    }
}
