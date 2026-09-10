//! The staging files paused uploads leave on the server, by destination.
//!
//! Kept below the session layer on purpose: a session being torn down has to
//! delete what is staged for its connection while it can still reach the
//! server. Deciding whether a staging file may be appended to is
//! `application::upload_resume`'s job; this is only the record of what exists.

use crate::protocol::ProtocolBackend;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::SystemTime;

/// Pause marks are set by cancellation and consumed by the upload it aborts.
/// A mark for anything else (a download, an upload whose task already failed)
/// has no consumer, so the set is bounded the way the pool bounds cancelled ids.
pub(crate) const MARK_CAP: usize = 256;

/// Identifies the destination a staging file is staged for. Keyed by
/// destination rather than by transfer id because every retry mints a fresh
/// attempt id, while the destination is what the staging file actually belongs
/// to — and what a competing upload would collide with.
#[derive(PartialEq, Eq, Hash, Clone)]
pub struct Key {
    pub connection_id: String,
    pub remote_path: String,
}

/// What the local source looked like when the paused attempt was reading it.
/// Size and mtime are the same quick check rsync trusts by default; here it is
/// only the first of two gates, never the last word.
#[derive(PartialEq, Eq, Clone, Copy)]
pub struct SourcePin {
    size: u64,
    mtime: Option<SystemTime>,
}

impl SourcePin {
    pub(crate) fn size(&self) -> u64 {
        self.size
    }
}

pub async fn pin(local_path: &Path) -> Option<SourcePin> {
    let metadata = tokio::fs::metadata(local_path).await.ok()?;
    Some(SourcePin {
        size: metadata.len(),
        mtime: metadata.modified().ok(),
    })
}

pub(crate) struct Paused {
    pub(crate) staging_path: String,
    pub(crate) local_path: String,
    pub(crate) pin: SourcePin,
    /// How far the paused attempt last reported, for showing before the next
    /// attempt has proven anything. Never what the resume appends from.
    pub(crate) staged: u64,
}

#[derive(Default)]
struct State {
    paused: HashMap<Key, Paused>,
    marks: Vec<String>,
}

fn state() -> &'static StdMutex<State> {
    static STATE: OnceLock<StdMutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// Records that this attempt is being cancelled to pause it, not to abandon it.
/// Must be set before the pool is told to cancel, so the upload it unblocks
/// always observes the mark.
pub fn mark_paused(transfer_id: &str) {
    let mut state = state().lock().unwrap();
    if state.marks.iter().any(|id| id == transfer_id) {
        return;
    }
    state.marks.push(transfer_id.to_string());
    if state.marks.len() > MARK_CAP {
        state.marks.remove(0);
    }
}

pub fn take_pause_mark(transfer_id: &str) -> bool {
    let mut state = state().lock().unwrap();
    if let Some(index) = state.marks.iter().position(|id| id == transfer_id) {
        state.marks.remove(index);
        return true;
    }
    false
}

pub fn remember(key: Key, staging_path: String, local_path: String, pin: SourcePin, staged: u64) {
    state().lock().unwrap().paused.insert(
        key,
        Paused {
            staging_path,
            local_path,
            pin,
            staged,
        },
    );
}

/// How much of this destination a paused upload reported sent, if one is
/// staged for it.
pub fn staged_len(key: &Key) -> Option<u64> {
    let state = state().lock().unwrap();
    state.paused.get(key).map(|entry| entry.staged)
}

/// Claiming an entry removes it: from here on the caller owns that staging file
/// and must either finish it, hand it back with [`remember`], or delete it.
pub(crate) fn take(key: &Key) -> Option<Paused> {
    state().lock().unwrap().paused.remove(key)
}

pub(crate) async fn remove_staging_on(
    browse: &mut (dyn ProtocolBackend + Send),
    staging_path: &str,
) {
    if let Err(error) = browse.remove(staging_path, false).await {
        log::warn!("Could not remove staging file {staging_path}: {error}");
    }
}

/// Abandons everything held for a connection. Takes the browsing backend
/// directly because teardown already owns the session: the deletions have to
/// happen while the connection can still reach the server, and once it is
/// closed no route to those files is left.
pub async fn discard_for_connection(
    browse: &mut (dyn ProtocolBackend + Send),
    connection_id: &str,
) {
    let abandoned: Vec<String> = {
        let mut state = state().lock().unwrap();
        let keys: Vec<Key> = state
            .paused
            .keys()
            .filter(|key| key.connection_id == connection_id)
            .cloned()
            .collect();
        keys.iter()
            .filter_map(|key| state.paused.remove(key))
            .map(|entry| entry.staging_path)
            .collect()
    };
    for staging_path in abandoned {
        remove_staging_on(browse, &staging_path).await;
    }
}
