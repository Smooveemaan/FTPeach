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
    pub fn emit(&self, line: impl Into<LogText>, kind: LogKind) {
        if let Some(sink) = self.sink.read().unwrap().as_ref() {
            sink(line.into(), kind);
        }
    }

    pub fn event(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.emit(LogText::event(key, params), kind);
    }

    pub fn set_sink(&self, sink: Option<LogSink>) {
        *self.sink.write().unwrap() = sink;
    }
}
