//! Bounded manifests shared by recursive transfer scanning and verification.
use crate::ipc::{CommandError, ErrorCode};
use anyhow::Result;

pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_MANIFEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DEPTH: usize = 40;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub relative: String,
    pub directory: bool,
    pub size: u64,
    pub modified: Option<String>,
}

#[derive(Default)]
pub struct Manifest {
    pub entries: Vec<Entry>,
    memory: usize,
}

impl Manifest {
    pub fn push(&mut self, entry: Entry) -> Result<()> {
        let memory = self
            .memory
            .saturating_add(std::mem::size_of::<Entry>())
            .saturating_add(entry.relative.len())
            .saturating_add(entry.modified.as_ref().map_or(0, String::len));
        if self.entries.len() == MAX_ENTRIES || memory > MAX_MANIFEST_BYTES {
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                "Recursive manifest exceeds its entry or memory budget",
            )
            .into());
        }
        self.memory = memory;
        self.entries.push(entry);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_100k_entries_and_rejects_over_budget_before_growing() {
        let mut manifest = Manifest::default();
        for index in 0..MAX_ENTRIES {
            manifest
                .push(Entry {
                    relative: index.to_string(),
                    directory: false,
                    size: 0,
                    modified: None,
                })
                .unwrap();
        }
        assert_eq!(manifest.entries.len(), MAX_ENTRIES);
        assert!(
            manifest
                .push(Entry {
                    relative: "extra".into(),
                    directory: false,
                    size: 0,
                    modified: None
                })
                .is_err()
        );
        let mut manifest = Manifest::default();
        assert!(
            manifest
                .push(Entry {
                    relative: "x".repeat(MAX_MANIFEST_BYTES),
                    directory: false,
                    size: 0,
                    modified: None
                })
                .is_err()
        );
        assert!(manifest.entries.is_empty());
    }
}
