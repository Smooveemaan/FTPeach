//! Resuming paused uploads.
//!
//! An upload writes into a randomly named staging file and renames it onto the
//! destination only once complete. Pausing keeps that staging file behind,
//! recorded in `transfer::upload_staging`, so the next attempt can append to it
//! instead of re-sending everything.
//!
//! Appending means trusting bytes some earlier attempt wrote, so an entry here
//! is a claim to be proven rather than a fact. The local source is pinned when
//! the transfer starts, and the overlap is read back off the server before a
//! single new byte is appended. Anything left unproven falls back to a full
//! re-upload: that costs time, never correctness. A staging file this module
//! refuses is deleted on the spot, so a refusal never leaks server-side state.

#[cfg(test)]
#[path = "upload_resume_tests.rs"]
mod tests;

use crate::protocol::LogKind;
use crate::session::Sessions;
pub(crate) use crate::transfer::upload_staging::{
    Key, mark_paused, pin, remember, staged_len, take_pause_mark,
};
use crate::transfer::upload_staging::{Paused, SourcePin, remove_staging_on, take};
use std::path::Path;

/// Read back at most this much of the staging tail to prove the overlap.
///
/// A small constant, because these are bytes off the wire at whatever the link
/// actually does — not at whatever the bandwidth limit allows. A window that
/// tracked progress made every resume slower than the one before it, and even a
/// fixed 64 KiB is six seconds of an apparently stuck queue on a 10 KB/s link.
///
/// It can be a sample rather than a full audit because truncation — what a torn
/// write actually causes — is not what these bytes catch. The offset is the
/// server's own reported length, and everything below it is a prefix of what we
/// sent by construction: SFTP writes are framed and acknowledged whole, and FTP
/// rides in-order TCP. What a sample catches is a stream that was never
/// byte-transparent or never ours — ASCII-mode translation, a rewriting
/// middlebox, a staging name that resolved to somebody else's file — and any
/// window of a real file betrays those. The source pin covers the rest.
const VERIFY_WINDOW: u64 = 8 * 1024;

async fn remove_staging(sessions: &Sessions, connection_id: &str, staging_path: &str) {
    let slot = sessions.slot_for(connection_id);
    let mut guard = slot.lock().await;
    if let Some(session) = guard.as_mut() {
        remove_staging_on(session.browse_client.as_mut(), staging_path).await;
    }
}

/// Abandons any staging held for this destination, deleting it server-side.
pub async fn discard(sessions: &Sessions, key: &Key) {
    if let Some(entry) = take(key) {
        remove_staging(sessions, &key.connection_id, &entry.staging_path).await;
    }
}

/// Why a paused upload cannot pick up where it left off.
///
/// Every variant ends the same way — the staging file is deleted and the file
/// is sent again from the start — so the only thing that varies is what the
/// user is told. Restarting is silent from the outside, and silence here reads
/// as a bug rather than as the fallback it is, so each of these becomes a line
/// in the connection's log.
enum Restart {
    /// The local file is no longer the one the staging file was built from:
    /// either it was edited while paused, or another file now targets this
    /// destination. Both mean the same thing — the source cannot be vouched for.
    SourceChanged,
    /// The source is unchanged, but what is on the server is not a prefix of
    /// it. A write torn by a lost connection lands here.
    Mismatch,
    /// The overlap could not be read back at all, so nothing can be proven.
    Unverified(String),
}

impl Restart {
    fn log_key(&self) -> &'static str {
        match self {
            Restart::SourceChanged => "uploadRestartedSourceChanged",
            Restart::Mismatch => "uploadRestartedMismatch",
            Restart::Unverified(_) => "uploadRestartedUnverified",
        }
    }

    fn params(&self, path: &str) -> serde_json::Value {
        match self {
            Restart::Unverified(error) => serde_json::json!({ "path": path, "error": error }),
            _ => serde_json::json!({ "path": path }),
        }
    }
}

/// Decides whether the staging held for this destination may be appended to.
///
/// Every path out of here that is not `Some` has already deleted the staging
/// file, so the caller can start a fresh one without leaking the old.
///
/// The returned offset is for reporting only. The upload re-reads the staging
/// length when it appends, and that read is the authoritative one; nothing else
/// can write to this staging file, because the caller holds the destination's
/// reservation for as long as the transfer runs.
pub async fn resolve(
    sessions: &Sessions,
    key: &Key,
    local_path: &Path,
    now: SourcePin,
) -> Option<(String, u64)> {
    let entry = take(key)?;
    let restart = if entry.local_path != local_path.to_string_lossy() || entry.pin != now {
        Restart::SourceChanged
    } else {
        match verify_overlap(sessions, key, &entry, local_path, now.size()).await {
            Ok(Some(offset)) => {
                log_event(
                    sessions,
                    &key.connection_id,
                    "uploadResumed",
                    serde_json::json!({ "path": key.remote_path, "offset": offset }),
                )
                .await;
                return Some((entry.staging_path, offset));
            }
            Ok(None) => Restart::Mismatch,
            Err(error) => Restart::Unverified(format!("{error:#}")),
        }
    };

    log::info!(
        "Restarting upload of {} from the beginning: {}",
        key.remote_path,
        restart.log_key()
    );
    let slot = sessions.slot_for(&key.connection_id);
    let mut guard = slot.lock().await;
    if let Some(session) = guard.as_mut() {
        session.browse_client.log_event(
            restart.log_key(),
            restart.params(&key.remote_path),
            LogKind::Status,
        );
        remove_staging_on(session.browse_client.as_mut(), &entry.staging_path).await;
    }
    None
}

async fn log_event(
    sessions: &Sessions,
    connection_id: &str,
    key: &'static str,
    params: serde_json::Value,
) {
    let slot = sessions.slot_for(connection_id);
    let guard = slot.lock().await;
    if let Some(session) = guard.as_ref() {
        session
            .browse_client
            .log_event(key, params, LogKind::Status);
    }
}

/// Proves the staging tail still matches the local source, yielding the offset
/// to append from. `Ok(None)` is a mismatch; `Err` means the proof could not be
/// obtained at all. Both refuse the resume — only the log line differs.
async fn verify_overlap(
    sessions: &Sessions,
    key: &Key,
    entry: &Paused,
    local_path: &Path,
    local_size: u64,
) -> anyhow::Result<Option<u64>> {
    let slot = sessions.slot_for(&key.connection_id);
    let mut guard = slot.lock().await;
    let session = guard
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("the connection is gone"))?;
    let Some(offset) = session.browse_client.known_size(&entry.staging_path).await else {
        return Ok(None);
    };
    // Nothing worth resuming, and a staging file longer than its own source
    // cannot be a prefix of it.
    if offset == 0 || offset > local_size {
        return Ok(None);
    }
    // `at + window == offset`, which is the staging file's length, so the range
    // always ends at end of file — the shape every backend can read safely.
    // A non-zero `at` is the normal case at this window size, so verification
    // leans on the same positioned read a resumed download already needs: a
    // server that cannot do one cannot resume anything, and answers here with a
    // refusal, which costs a full re-upload rather than a wrong one.
    let window = offset.min(VERIFY_WINDOW);
    let at = offset - window;
    let remote = session
        .browse_client
        .read_range(&entry.staging_path, at, window as usize)
        .await?;
    if remote.len() as u64 != window {
        return Ok(None);
    }
    drop(guard);

    let local = read_local_window(local_path, at, window as usize).await?;
    Ok((local == remote).then_some(offset))
}

async fn read_local_window(local_path: &Path, at: u64, len: usize) -> anyhow::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(local_path).await?;
    file.seek(std::io::SeekFrom::Start(at)).await?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}
