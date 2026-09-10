//! What a recursive walk has written. A pause keeps it so the next attempt
//! can carry on where this one stopped; a stop uses it to take back exactly
//! what the walk made, and nothing that was there before it.
use super::io::remove_created;
use super::model::Endpoint;
use crate::application::upload_resume;
use crate::protocol::transfer_file::discard_resume_artifacts;
use crate::session::Sessions;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{LazyLock, Mutex};

#[derive(Default)]
pub(super) struct Journal {
    /// Directories that did not exist until this walk made them.
    pub created_dirs: HashSet<String>,
    /// Files this walk wrote where nothing stood before. Files it overwrote
    /// are left out: taking those back would only lose them altogether.
    pub created_files: HashSet<String>,
    /// Files already delivered, with the source size and timestamp they were
    /// copied from, so a resume can tell whether they are still current.
    pub done: HashMap<String, (u64, Option<String>)>,
    /// The file being copied when the walk was interrupted.
    pub in_flight: Option<String>,
    /// A move has begun deleting its source, so the target now holds the only
    /// copy of what is gone and must never be taken back.
    pub source_deletion_started: bool,
}

/// A paused walk's journal, with the endpoints it describes.
pub(super) struct Paused {
    pub source: Endpoint,
    pub target: Endpoint,
    pub journal: Journal,
}

/// A row cleared from the queue never says so, so the oldest paused walks are
/// forgotten past this many. Forgetting one only means it cannot be resumed.
const MAX_PAUSED: usize = 32;
static PAUSED: LazyLock<Mutex<VecDeque<(String, Paused)>>> = LazyLock::new(Default::default);

pub(super) fn keep(id: String, paused: Paused) {
    let mut kept = PAUSED.lock().unwrap();
    if kept.len() == MAX_PAUSED
        && let Some((forgotten, _)) = kept.pop_front()
    {
        log::warn!("Forgot paused folder transfer {forgotten}; it can no longer be resumed");
    }
    kept.push_back((id, paused));
}

/// Takes the journal a paused attempt kept, provided it describes this walk.
pub(super) fn take(id: &str, source: &Endpoint, target: &Endpoint) -> Option<Journal> {
    let mut kept = PAUSED.lock().unwrap();
    let index = kept.iter().position(|(kept_id, paused)| {
        kept_id == id && &paused.source == source && &paused.target == target
    })?;
    kept.remove(index).map(|(_, paused)| paused.journal)
}

pub(super) fn take_any(id: &str) -> Option<Paused> {
    let mut kept = PAUSED.lock().unwrap();
    let index = kept.iter().position(|(kept_id, _)| kept_id == id)?;
    kept.remove(index).map(|(_, paused)| paused)
}

/// Removes what the journal says this walk made on `target`, files first and
/// then folders deepest first, so each folder is empty by the time its turn
/// comes. A folder that is not empty by then holds something the walk did not
/// make, and stays. The stop has already happened, so whatever cannot be
/// removed is logged and left.
pub(super) async fn take_back(sessions: &Sessions, target: &Endpoint, journal: &Journal) {
    if journal.source_deletion_started {
        return;
    }
    if let Endpoint::Local { .. } = target {
        // A download keeps a resume sidecar beside every file, and one cut
        // short keeps its partial too; a folder holding either cannot go.
        for relative in journal.created_files.iter().chain(&journal.in_flight) {
            discard_resume_artifacts(Path::new(&target.path(relative))).await;
        }
    }
    if let (Endpoint::Remote { connection_id, .. }, Some(relative)) = (target, &journal.in_flight) {
        // An upload cut short by the pause kept its staging file beside the
        // file for the resume, which will now never come; and a folder holding
        // it could not go either.
        let key = upload_resume::Key {
            connection_id: connection_id.clone(),
            remote_path: target.path(relative),
        };
        upload_resume::discard(sessions, &key).await;
    }
    for relative in &journal.created_files {
        if let Err(error) = remove_created(sessions, target, relative, false).await {
            log::warn!("Could not take back {}: {error:#}", target.path(relative));
        }
    }
    let mut directories: Vec<&String> = journal.created_dirs.iter().collect();
    directories.sort_by_key(|relative| {
        std::cmp::Reverse(relative.split('/').filter(|part| !part.is_empty()).count())
    });
    for relative in directories {
        if let Err(error) = remove_created(sessions, target, relative, true).await {
            log::warn!("Could not take back {}: {error:#}", target.path(relative));
        }
    }
}
