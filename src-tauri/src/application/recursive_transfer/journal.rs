//! What a recursive walk has written. A pause keeps it so the next attempt
//! can carry on where this one stopped; a stop uses it to take back exactly
//! what the walk made, and nothing that was there before it.
use super::identity;
use super::io::remove_created;
use super::model::Endpoint;
use crate::ipc::{CommandError, ErrorCode};
use crate::session::Sessions;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};

#[derive(Default)]
pub(super) struct Journal {
    pub operation_id: String,
    /// Exact paths, retained for diagnostics; never deleted by name pattern.
    pub staging: Vec<String>,
    /// Directories that did not exist until this walk made them.
    pub created_dirs: HashSet<String>,
    /// Files this walk wrote where nothing stood before. Files it overwrote
    /// are left out: taking those back would only lose them altogether.
    pub created_files: HashSet<String>,
    /// Files already delivered, with the source size and timestamp they were
    /// copied from, so a resume can tell whether they are still current.
    pub done: HashMap<String, (u64, Option<String>)>,
    pub targets: HashMap<String, super::io::Stamp>,
    pub sources: HashMap<String, identity::Receipt>,
    pub directories: HashMap<String, identity::Receipt>,
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

const MAX_PAUSED: usize = 32;
const MAX_PAUSED_BYTES: usize = 64 * 1024 * 1024;
static PAUSED: LazyLock<Mutex<VecDeque<(String, Paused)>>> = LazyLock::new(Default::default);

impl Paused {
    fn estimated_bytes(&self) -> usize {
        let j = &self.journal;
        // Include allocated capacity and conservative hash-table/control overhead.
        let strings = j
            .staging
            .iter()
            .chain(j.created_dirs.iter())
            .chain(j.created_files.iter())
            .chain(j.done.keys())
            .chain(j.targets.keys())
            .chain(j.sources.keys())
            .chain(j.directories.keys())
            .map(|s| s.capacity())
            .sum::<usize>();
        let slots = j.created_dirs.capacity()
            + j.created_files.capacity()
            + j.done.capacity()
            + j.targets.capacity()
            + j.sources.capacity()
            + j.directories.capacity();
        std::mem::size_of::<Self>()
            + strings
            + slots * 256
            + j.staging.capacity() * std::mem::size_of::<String>()
            + j.operation_id.capacity()
            + j.in_flight.as_ref().map_or(0, String::capacity)
            + j.done
                .values()
                .map(|(_, t)| t.as_ref().map_or(0, String::capacity))
                .sum::<usize>()
            + j.targets
                .values()
                .map(|stamp| match stamp {
                    super::io::Stamp::Remote { modified, .. } => modified.capacity(),
                    _ => 0,
                })
                .sum::<usize>()
            + [&self.source, &self.target]
                .iter()
                .map(|endpoint| match endpoint {
                    Endpoint::Local { path } => path.capacity(),
                    Endpoint::Remote {
                        path,
                        connection_id,
                    } => path.capacity() + connection_id.capacity(),
                })
                .sum::<usize>()
    }
}

fn keep_in(
    kept: &mut VecDeque<(String, Paused)>,
    id: String,
    paused: Paused,
) -> Result<(), Box<Paused>> {
    let used = kept
        .iter()
        .map(|(id, p)| id.capacity() + p.estimated_bytes())
        .sum::<usize>();
    if kept.len() >= MAX_PAUSED
        || used
            .saturating_add(paused.estimated_bytes())
            .saturating_add(id.capacity())
            > MAX_PAUSED_BYTES
    {
        return Err(Box::new(paused));
    }
    kept.push_back((id, paused));
    Ok(())
}

pub(super) fn keep(id: String, paused: Paused) -> Result<(), Box<Paused>> {
    let mut kept = PAUSED.lock().unwrap();
    keep_in(&mut kept, id, paused)
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

pub(super) fn close_connection(connection_id: &str) {
    PAUSED.lock().unwrap().retain(|(id, paused)| {
        if paused.source.connection() != connection_id
            && paused.target.connection() != connection_id
        {
            return true;
        }
        log::warn!(
            "Disconnected recursive journal {id}; results retained at {}",
            paused.target.path("")
        );
        if let Endpoint::Remote { connection_id, .. } = &paused.target
            && let Some(relative) = &paused.journal.in_flight
        {
            let key = crate::transfer::upload_staging::Key {
                connection_id: connection_id.clone(),
                remote_path: paused.target.path(relative),
            };
            for path in &paused.journal.staging {
                crate::transfer::upload_staging::forget_retained(&key, path);
            }
        }
        false
    });
}

/// Removes what the journal says this walk made on `target`, files first and
/// then folders deepest first, so each folder is empty by the time its turn
/// comes. A folder that is not empty by then holds something the walk did not
/// make, and stays. The stop has already happened, so whatever cannot be
/// removed is returned to the caller and left.
pub(super) async fn take_back(
    sessions: &Sessions,
    target: &Endpoint,
    journal: &Journal,
) -> Vec<CommandError> {
    let mut errors = Vec::new();
    if journal.source_deletion_started {
        return errors;
    }
    if let Some(relative) = &journal.in_flight {
        if let Endpoint::Remote { connection_id, .. } = target {
            let key = crate::transfer::upload_staging::Key {
                connection_id: connection_id.clone(),
                remote_path: target.path(relative),
            };
            for path in &journal.staging {
                crate::transfer::upload_staging::forget_retained(&key, path);
            }
        }
        // A path (including an exact staging path) alone cannot prove that
        // its current contents still belong to this operation.
        errors.push(CommandError::new(
            ErrorCode::CleanupIncomplete,
            format!(
                "Cleanup incomplete: operation {} retained unverified partials for {}: {}",
                journal.operation_id,
                target.path(relative),
                journal.staging.join(", ")
            ),
        ));
    }
    for relative in &journal.created_files {
        let expected = journal.targets.get(relative).and_then(|stamp| match stamp {
            super::io::Stamp::Local(receipt) => Some(receipt),
            _ => None,
        });
        if let Err(error) = remove_created(sessions, target, relative, expected).await
            && errors.len() < 100
        {
            errors.push(CommandError::new(
                ErrorCode::CleanupIncomplete,
                format!(
                    "Cleanup incomplete: {} retained: {error:#}",
                    target.path(relative)
                ),
            ));
        }
    }
    let mut directories: Vec<&String> = journal.created_dirs.iter().collect();
    directories.sort_by_key(|relative| {
        std::cmp::Reverse(relative.split('/').filter(|part| !part.is_empty()).count())
    });
    for relative in directories {
        if let Err(error) = remove_created(
            sessions,
            target,
            relative,
            journal.directories.get(relative),
        )
        .await
            && errors.len() < 100
        {
            errors.push(CommandError::new(
                ErrorCode::CleanupIncomplete,
                format!(
                    "Cleanup incomplete: {} retained: {error:#}",
                    target.path(relative)
                ),
            ));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paused() -> Paused {
        Paused {
            source: Endpoint::Local {
                path: "source".into(),
            },
            target: Endpoint::Local {
                path: "target".into(),
            },
            journal: Journal::default(),
        }
    }

    #[test]
    fn pause_budget_never_evicts_previous_journals() {
        let mut kept = VecDeque::new();
        for id in 0..32 {
            assert!(keep_in(&mut kept, id.to_string(), paused()).is_ok());
        }
        for id in 32..100 {
            assert!(keep_in(&mut kept, id.to_string(), paused()).is_err());
        }
        assert_eq!(kept.len(), 32);
        assert_eq!(kept.front().unwrap().0, "0");
        kept.pop_front();
        assert!(keep_in(&mut kept, "next".into(), paused()).is_ok());
    }

    #[test]
    fn pause_budget_accounts_for_allocated_memory() {
        let mut kept = VecDeque::new();
        let mut large = paused();
        large.journal.operation_id = String::with_capacity(MAX_PAUSED_BYTES);
        assert!(keep_in(&mut kept, "large".into(), large).is_err());
        assert!(kept.is_empty());
        let mut first = paused();
        first.journal.operation_id = String::with_capacity(MAX_PAUSED_BYTES / 2);
        assert!(keep_in(&mut kept, "first".into(), first).is_ok());
        let mut second = paused();
        second.journal.operation_id = String::with_capacity(MAX_PAUSED_BYTES / 2);
        assert!(keep_in(&mut kept, "second".into(), second).is_err());
        assert_eq!(kept.len(), 1);
    }
}
