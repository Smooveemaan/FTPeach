use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const FLUSH_INTERVAL_MS: u64 = 100;
/// How long a row that was at work must wait before it reads Queued.
const QUEUED_AFTER_WORK: Duration = Duration::from_secs(1);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressPayload {
    pub id: String,
    pub connection_id: String,
    /// "queued" while the transfer waits for a connection or a free slot,
    /// "progress" while it is at work, then "done" or "error". The first two
    /// may come without numbers, which leaves the row's own as they stand.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
    /// How many folders and files a folder walk has put in place on its target
    /// so far. The pane showing that target lists it again when this moves, so
    /// what the walk writes shows up while it runs, not only once it ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landed: Option<u64>,
    /// The file a folder walk is on, so its row shows more than the bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FolderFile>,
}

/// The file a folder walk is on: its place among the walk's files, from one,
/// and its path inside the folder.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FolderFile {
    pub number: u64,
    pub count: u64,
    pub path: String,
}

/// Where a child transfer's byte count belongs in its parent's running total.
#[derive(Clone)]
pub struct Aggregate {
    pub parent_id: String,
    pub connection_id: String,
    /// Bytes the parent had already finished before this child started.
    pub base: u64,
    pub total: u64,
    /// What the parent had put in place before this child started.
    pub landed: u64,
    pub file: FolderFile,
}

/// The children currently reporting on some parent's behalf.
///
/// A recursive walk copies one file at a time under a private `{id}:file`
/// progress id, which no queue row is listening for, so the walk's own row
/// would otherwise only move at file boundaries — a single large file leaves
/// it sitting at "0 B" for the whole transfer and then jumping straight to the
/// total.
#[derive(Clone, Default)]
struct AggregateIndex(Arc<Mutex<HashMap<String, Aggregate>>>);

impl AggregateIndex {
    fn track(&self, child_id: String, aggregate: Aggregate) -> AggregateGuard {
        self.0.lock().unwrap().insert(child_id.clone(), aggregate);
        AggregateGuard {
            index: self.clone(),
            child_id,
        }
    }

    /// The parent's version of a child payload, if that child is reporting for
    /// one. Only in-progress payloads roll up: a child's terminal event says
    /// nothing about whether the parent is finished.
    fn rolled_up(&self, payload: &TransferProgressPayload) -> Option<TransferProgressPayload> {
        if payload.status != "progress" {
            return None;
        }
        let aggregate = self.0.lock().unwrap().get(&payload.id).cloned()?;
        Some(TransferProgressPayload {
            id: aggregate.parent_id,
            connection_id: aggregate.connection_id,
            status: "progress",
            // A child's notice that it has started carries no byte count. It
            // puts the parent to work and leaves its count alone: read as
            // nothing done, it would drop the parent back to its base just as
            // a resumed file is about to carry on from its partial.
            bytes: payload
                .bytes
                .map(|bytes| aggregate.base.saturating_add(bytes)),
            total: Some(aggregate.total),
            error: None,
            error_code: None,
            // Carried along, or a child's report overtaking the parent's own
            // in the flush window would lose the count the parent just sent.
            landed: Some(aggregate.landed),
            file: Some(aggregate.file),
        })
    }
}

/// Reports one child id's progress as part of its parent's until dropped.
pub struct AggregateGuard {
    index: AggregateIndex,
    child_id: String,
}

impl Drop for AggregateGuard {
    fn drop(&mut self) {
        self.index.0.lock().unwrap().remove(&self.child_id);
    }
}

#[derive(Clone)]
pub struct ProgressEmitter {
    emit: Arc<dyn Fn(TransferProgressPayload) + Send + Sync>,
    pending: Arc<Mutex<HashMap<String, TransferProgressPayload>>>,
    /// Rows whose wait came after work in the window being batched, to be
    /// sent as queued in the next window unless work supersedes it.
    queued_after: Arc<Mutex<HashMap<String, std::time::Instant>>>,
    aggregates: AggregateIndex,
}

impl ProgressEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self::emitting(move |payload| {
            let _ = app.emit("transfer:progress", payload);
        })
    }

    /// An emitter that hands its payloads to `emit`, for tests that drive a
    /// transfer with no window to report to.
    #[cfg(test)]
    pub(crate) fn for_tests(
        emit: impl Fn(TransferProgressPayload) + Send + Sync + 'static,
    ) -> Self {
        Self::emitting(emit)
    }

    fn emitting(emit: impl Fn(TransferProgressPayload) + Send + Sync + 'static) -> Self {
        Self {
            emit: Arc::new(emit),
            pending: Arc::new(Mutex::new(HashMap::new())),
            queued_after: Arc::default(),
            aggregates: AggregateIndex::default(),
        }
    }

    /// Starts folding progress sent under `child_id` into its parent's own
    /// running total. The guard stops it again, so an early return cannot
    /// leave a stale entry behind.
    pub fn aggregate_into(&self, child_id: String, aggregate: Aggregate) -> AggregateGuard {
        self.aggregates.track(child_id, aggregate)
    }

    pub fn send(&self, payload: TransferProgressPayload) {
        let rolled_up = self.aggregates.rolled_up(&payload);
        self.enqueue(payload);
        if let Some(rolled_up) = rolled_up {
            self.enqueue(rolled_up);
        }
    }

    fn enqueue(&self, mut payload: TransferProgressPayload) {
        if !matches!(payload.status, "queued" | "progress") {
            self.queued_after.lock().unwrap().remove(&payload.id);
            let carried = self.pending.lock().unwrap().remove(&payload.id);
            if let Some(prev) = carried {
                payload.bytes = payload.bytes.or(prev.bytes);
                payload.total = payload.total.or(prev.total);
                payload.landed = payload.landed.or(prev.landed);
                payload.file = payload.file.or(prev.file);
            }
            (self.emit)(payload);
            return;
        }

        let mut pending = self.pending.lock().unwrap();
        if payload.status == "progress" {
            self.queued_after.lock().unwrap().remove(&payload.id);
        }
        if let Some(latest) = pending.get_mut(&payload.id) {
            // Keep the existing map key and timer; only replace the message. A
            // notice without numbers keeps the ones still waiting to be sent.
            payload.bytes = payload.bytes.or(latest.bytes);
            payload.total = payload.total.or(latest.total);
            payload.landed = payload.landed.or(latest.landed);
            payload.file = payload.file.or(latest.file.take());
            // A folder walk says it is queued before each file, and the file
            // that it has started a moment later; setting up the next file can
            // take longer than a window. Whichever came last would win, and the
            // row flickered between the two. A wait that comes after work is
            // shown only once it outlasts QUEUED_AFTER_WORK.
            if latest.status == "progress" && payload.status == "queued" {
                payload.status = "progress";
                self.queued_after
                    .lock()
                    .unwrap()
                    .insert(payload.id.clone(), std::time::Instant::now());
            }
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
                let connection_id = latest.connection_id.clone();
                (this.emit)(latest);
                let Some(since) = this.queued_after.lock().unwrap().get(&id).copied() else {
                    return;
                };
                tokio::time::sleep(QUEUED_AFTER_WORK).await;
                // Still the same wait: no work, ending or newer wait since.
                let mut queued_after = this.queued_after.lock().unwrap();
                if queued_after.get(&id) == Some(&since) {
                    queued_after.remove(&id);
                    drop(queued_after);
                    this.enqueue(TransferProgressPayload {
                        id,
                        connection_id,
                        status: "queued",
                        bytes: None,
                        total: None,
                        error: None,
                        error_code: None,
                        landed: None,
                        file: None,
                    });
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(id: &str, status: &'static str, bytes: Option<u64>) -> TransferProgressPayload {
        TransferProgressPayload {
            id: id.into(),
            connection_id: "child-connection".into(),
            status,
            bytes,
            total: Some(10),
            error: None,
            error_code: None,
            landed: None,
            file: None,
        }
    }

    fn aggregate() -> Aggregate {
        Aggregate {
            parent_id: "walk".into(),
            connection_id: "walk-connection".into(),
            base: 100,
            total: 900,
            landed: 3,
            file: FolderFile {
                number: 2,
                count: 5,
                path: "sub/b.bin".into(),
            },
        }
    }

    #[test]
    fn a_tracked_child_reports_its_bytes_on_top_of_the_parents_base() {
        let index = AggregateIndex::default();
        let _guard = index.track("walk:file".into(), aggregate());
        let rolled_up = index
            .rolled_up(&payload("walk:file", "progress", Some(50)))
            .expect("the child is tracked");
        assert_eq!(rolled_up.id, "walk");
        assert_eq!(rolled_up.connection_id, "walk-connection");
        assert_eq!(rolled_up.bytes, Some(150));
        assert_eq!(rolled_up.total, Some(900));
        assert_eq!(rolled_up.landed, Some(3));
        assert_eq!(
            rolled_up.file.map(|file| (file.number, file.count)),
            Some((2, 5))
        );
    }

    #[test]
    fn a_childs_own_ending_says_nothing_about_the_parent() {
        let index = AggregateIndex::default();
        let _guard = index.track("walk:file".into(), aggregate());
        assert!(
            index
                .rolled_up(&payload("walk:file", "done", None))
                .is_none()
        );
    }

    #[test]
    fn a_childs_notice_that_it_started_puts_the_parent_to_work_where_it_is() {
        let index = AggregateIndex::default();
        let _guard = index.track("walk:file".into(), aggregate());
        let rolled_up = index
            .rolled_up(&payload("walk:file", "progress", None))
            .expect("the child is tracked");
        assert_eq!(rolled_up.id, "walk");
        assert_eq!(rolled_up.status, "progress");
        assert_eq!(rolled_up.bytes, None);
    }

    #[tokio::test]
    async fn a_notice_without_numbers_keeps_the_ones_waiting_to_be_sent() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let seen = sent.clone();
        let emitter = ProgressEmitter::for_tests(move |payload| seen.lock().unwrap().push(payload));
        emitter.send(payload("walk", "progress", Some(7)));
        emitter.send(TransferProgressPayload {
            total: None,
            ..payload("walk", "queued", None)
        });
        tokio::time::sleep(Duration::from_millis(FLUSH_INTERVAL_MS * 3) + QUEUED_AFTER_WORK).await;
        let sent = sent.lock().unwrap();
        // The work in the window is reported first, and the wait that came
        // after it once it has gone on for a while.
        let sent: Vec<_> = sent.iter().map(|p| (p.status, p.bytes, p.total)).collect();
        assert_eq!(
            sent,
            [("progress", Some(7), Some(10)), ("queued", None, None)]
        );
    }

    /// A file that ends inside the batching window still reports the size the
    /// server gave it, not only how much arrived.
    #[test]
    fn an_ending_carries_the_numbers_still_waiting_to_be_sent() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let seen = sent.clone();
        let emitter = ProgressEmitter::for_tests(move |payload| seen.lock().unwrap().push(payload));
        tauri::async_runtime::block_on(async {
            emitter.send(payload("file", "progress", Some(10)));
            emitter.send(TransferProgressPayload {
                total: None,
                ..payload("file", "done", None)
            });
        });
        let sent = sent.lock().unwrap();
        assert_eq!((sent[0].bytes, sent[0].total), (Some(10), Some(10)));
    }

    #[tokio::test]
    async fn a_wait_between_files_does_not_flicker_the_row() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let seen = sent.clone();
        let emitter = ProgressEmitter::for_tests(move |payload| seen.lock().unwrap().push(payload));
        // A walk of small files: a short wait before each, then work.
        for bytes in 1..=5 {
            emitter.send(payload("walk", "queued", None));
            emitter.send(payload("walk", "progress", Some(bytes)));
        }
        // The window closes on the wait before the next file, which starts in
        // the window after.
        emitter.send(payload("walk", "queued", None));
        tokio::time::sleep(Duration::from_millis(FLUSH_INTERVAL_MS * 3 / 2)).await;
        emitter.send(payload("walk", "progress", Some(6)));
        tokio::time::sleep(Duration::from_millis(FLUSH_INTERVAL_MS * 3)).await;
        let sent = sent.lock().unwrap();
        let sent: Vec<_> = sent.iter().map(|p| (p.status, p.bytes)).collect();
        assert_eq!(sent, [("progress", Some(5)), ("progress", Some(6))]);
    }

    #[test]
    fn nothing_is_rolled_up_once_the_guard_is_gone() {
        let index = AggregateIndex::default();
        drop(index.track("walk:file".into(), aggregate()));
        assert!(
            index
                .rolled_up(&payload("walk:file", "progress", Some(50)))
                .is_none()
        );
        assert!(
            index
                .rolled_up(&payload("someone-else", "progress", Some(50)))
                .is_none()
        );
    }
}
