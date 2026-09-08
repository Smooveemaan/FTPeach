use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const FLUSH_INTERVAL_MS: u64 = 100;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressPayload {
    pub id: String,
    pub connection_id: String,
    pub status: &'static str, // "progress" | "done" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}

#[derive(Clone)]
pub struct ProgressEmitter {
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, TransferProgressPayload>>>,
}

impl ProgressEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn send(&self, mut payload: TransferProgressPayload) {
        if payload.status != "progress" {
            let carried = self.pending.lock().unwrap().remove(&payload.id);
            if payload.bytes.is_none()
                && let Some(prev) = carried
            {
                payload.bytes = prev.bytes;
            }
            let _ = self.app.emit("transfer:progress", payload);
            return;
        }

        let mut pending = self.pending.lock().unwrap();
        if let Some(latest) = pending.get_mut(&payload.id) {
            // Keep the existing map key and timer; only replace the message.
            *latest = payload;
            return;
        }
        let id = payload.id.clone();
        pending.insert(id.clone(), payload);
        drop(pending);

        let this = self.clone();
        // Not a bare `tokio::spawn`: drag-out downloads report progress from
        // COM worker threads (native_drag::windows), which have no Tokio
        // context, and a bare spawn there panics — inside a COM callback that
        // can't unwind, taking the whole process down.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(FLUSH_INTERVAL_MS)).await;
            let latest = this.pending.lock().unwrap().remove(&id);
            if let Some(latest) = latest {
                let _ = this.app.emit("transfer:progress", latest);
            }
        });
    }
}
