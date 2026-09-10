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
    /// How many folders and files a folder walk has put in place on its target
    /// so far. The pane showing that target lists it again when this moves, so
    /// what the walk writes shows up while it runs, not only once it ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landed: Option<u64>,
}

/// Where a child transfer's byte count belongs in its parent's running total.
#[derive(Clone)]
struct Aggregate {
    parent_id: String,
    connection_id: String,
    /// Bytes the parent had already finished before this child started.
    base: u64,
    total: u64,
    /// What the parent had put in place before this child started.
    landed: u64,
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
        // Nor does a child's notice that it has started, which carries no byte
        // count: read as nothing done, it would drop the parent back to its base
        // just as a resumed file is about to carry on from its partial.
        let bytes = payload.bytes.filter(|_| payload.status == "progress")?;
        let aggregate = self.0.lock().unwrap().get(&payload.id).cloned()?;
        Some(TransferProgressPayload {
            id: aggregate.parent_id,
            connection_id: aggregate.connection_id,
            status: "progress",
            bytes: Some(aggregate.base.saturating_add(bytes)),
            total: Some(aggregate.total),
            error: None,
            error_code: None,
            // Carried along, or a child's report overtaking the parent's own
            // in the flush window would lose the count the parent just sent.
            landed: Some(aggregate.landed),
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
            aggregates: AggregateIndex::default(),
        }
    }

    /// Starts folding progress sent under `child_id` into `parent_id`'s own
    /// running total, `base` bytes into a transfer of `total` bytes, with
    /// `landed` entries already in place. The guard stops it again, so an early
    /// return cannot leave a stale entry behind.
    pub fn aggregate_into(
        &self,
        child_id: String,
        parent_id: String,
        connection_id: String,
        base: u64,
        total: u64,
        landed: u64,
    ) -> AggregateGuard {
        self.aggregates.track(
            child_id,
            Aggregate {
                parent_id,
                connection_id,
                base,
                total,
                landed,
            },
        )
    }

    pub fn send(&self, payload: TransferProgressPayload) {
        let rolled_up = self.aggregates.rolled_up(&payload);
        self.enqueue(payload);
        if let Some(rolled_up) = rolled_up {
            self.enqueue(rolled_up);
        }
    }

    fn enqueue(&self, mut payload: TransferProgressPayload) {
        if payload.status != "progress" {
            let carried = self.pending.lock().unwrap().remove(&payload.id);
            if let Some(prev) = carried {
                payload.bytes = payload.bytes.or(prev.bytes);
                payload.landed = payload.landed.or(prev.landed);
            }
            (self.emit)(payload);
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
                (this.emit)(latest);
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
        }
    }

    fn aggregate() -> Aggregate {
        Aggregate {
            parent_id: "walk".into(),
            connection_id: "walk-connection".into(),
            base: 100,
            total: 900,
            landed: 3,
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
    fn a_childs_notice_that_it_started_leaves_the_parent_where_it_is() {
        let index = AggregateIndex::default();
        let _guard = index.track("walk:file".into(), aggregate());
        assert!(
            index
                .rolled_up(&payload("walk:file", "progress", None))
                .is_none()
        );
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
