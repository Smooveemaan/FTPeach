//! Process-wide target leases. A recursive operation owns a root lease and
//! lends it to its own child file tasks through a task-local owner token.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

tokio::task_local! { pub static OWNER: String; }
fn targets() -> &'static Mutex<HashMap<String, String>> {
    static TARGETS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TARGETS.get_or_init(Default::default)
}
fn key(path: &str) -> String {
    let local = std::path::Path::new(path);
    let resolved = if local.is_absolute() && (path.contains(':') || path.starts_with("\\\\")) {
        crate::local_fs::filesystem_safety::resolved_path(local)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };
    let mut parts = Vec::new();
    for part in resolved.as_deref().unwrap_or(path).split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part.to_lowercase()),
        }
    }
    parts.join("/")
}
pub struct Reservation(Option<String>);
impl Reservation {
    pub fn acquire(path: &str) -> anyhow::Result<Self> {
        let key = key(path);
        let owner = OWNER
            .try_with(Clone::clone)
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
        let mut active = targets().lock().unwrap();
        let overlaps = |other: &String| {
            key.is_empty()
                || other.is_empty()
                || other == &key
                || other.starts_with(&format!("{key}/"))
                || key.starts_with(&format!("{other}/"))
        };
        anyhow::ensure!(
            !active
                .iter()
                .any(|(other, held_by)| overlaps(other) && held_by != &owner),
            "Destination already has an active writer: {path}"
        );
        if active
            .iter()
            .any(|(other, held_by)| overlaps(other) && held_by == &owner)
        {
            return Ok(Self(None));
        }
        active.insert(key.clone(), owner);
        Ok(Self(Some(key)))
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(key) = &self.0 {
            targets().lock().unwrap().remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tabs_cannot_reserve_aliases_of_the_same_target() {
        let first = Reservation::acquire("/reservation-test/Report.txt").unwrap();
        assert!(Reservation::acquire("/reservation-test/./report.txt").is_err());
        drop(first);
        assert!(Reservation::acquire("/reservation-test/report.txt").is_ok());
    }
}
