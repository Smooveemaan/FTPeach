//! Lexical checks on remote paths, before any server is asked.

pub const MAX_REMOTE_PATH_LEN: usize = 4096;

pub fn validate_remote_path(path: &str) -> anyhow::Result<()> {
    if path.len() > MAX_REMOTE_PATH_LEN {
        anyhow::bail!(crate::ipc::CommandError::new(
            crate::ipc::ErrorCode::ResourceLimit,
            "Remote path exceeds the 4096-byte limit",
        ));
    }
    Ok(())
}

/// A conservative lexical guard; native directory rename remains responsible
/// for server aliases and mount semantics. Never emulate it with copy/delete.
/// Renaming an entry to its own name in another case is not a move into itself.
pub fn validate_remote_relationship(source: &str, destination: &str) -> anyhow::Result<()> {
    fn components(path: &str) -> Vec<&str> {
        let mut parts = Vec::new();
        for part in path.split(['/', '\\']) {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part),
            }
        }
        parts
    }
    let folded = |parts: &[&str]| {
        parts
            .iter()
            .map(|part| part.to_lowercase())
            .collect::<Vec<_>>()
    };
    let (source, target) = (components(source), components(destination));
    let (source_folded, target_folded) = (folded(&source), folded(&target));
    let same_parent = source.split_last().map(|(_, parent)| parent)
        == target.split_last().map(|(_, parent)| parent);
    if target_folded == source_folded && target != source && same_parent {
        return Ok(());
    }
    if target_folded.starts_with(&source_folded) {
        anyhow::bail!(crate::ipc::CommandError::new(
            crate::ipc::ErrorCode::InsideSource,
            format!("{destination}: Destination is the source or is inside the source folder"),
        ));
    }
    Ok(())
}
