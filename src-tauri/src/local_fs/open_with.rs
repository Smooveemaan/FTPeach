use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

struct Watcher {
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct OpenWithWatchers {
    inner: Arc<Mutex<HashMap<String, Watcher>>>,
}

impl OpenWithWatchers {
    pub fn start(&self, app: AppHandle, id: String, local_path: PathBuf) {
        let stop = Arc::new(AtomicBool::new(false));
        self.inner
            .lock()
            .unwrap()
            .insert(id.clone(), Watcher { stop: stop.clone() });

        tokio::spawn(async move {
            let mut last = stat_signature(&local_path).await;
            let mut interval = tokio::time::interval(POLL_INTERVAL);
            interval.tick().await; // first tick is immediate; skip it
            loop {
                interval.tick().await;
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let current = stat_signature(&local_path).await;
                let Some(current) = current else { continue };
                if last == Some(current) {
                    continue;
                }
                last = Some(current);
                let _ = app.emit("openWith:changed", serde_json::json!({ "id": id }));
            }
        });
    }

    /// Stops watching; the temp copy is left in place on purpose — the
    /// external app may still hold it open, and deleting it out from under
    /// an editor the user is looking at is worse than a stray file in the
    /// OS temp dir.
    pub fn stop(&self, id: &str) {
        if let Some(watcher) = self.inner.lock().unwrap().remove(id) {
            watcher.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Stops every watcher during application shutdown. The coordinator owns
    /// deletion of the corresponding session temp directory.
    pub fn stop_all(&self) {
        let watchers: Vec<Watcher> = self.inner.lock().unwrap().drain().map(|(_, w)| w).collect();
        for watcher in watchers {
            watcher.stop.store(true, Ordering::Relaxed);
        }
    }
}

async fn stat_signature(path: &std::path::Path) -> Option<(SystemTime, u64)> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    Some((
        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        meta.len(),
    ))
}
