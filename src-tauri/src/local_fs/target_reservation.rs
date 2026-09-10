//! Process-wide leases on the places operations read and write. A recursive
//! operation owns its root leases and lends them to its own child file tasks
//! through a task-local owner token.
//!
//! A place is a path on the local disk or on one server: the same remote path
//! on two servers is two places. Writing a place keeps every other owner out
//! of it; reading one only keeps writers out, so any number of transfers can
//! send the same source at once.
use crate::ipc::{CommandError, ErrorCode};
use crate::session::Sessions;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

tokio::task_local! { pub static OWNER: String; }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

struct Lease {
    id: u64,
    /// `None` for the local disk, otherwise the server the path is on.
    server: Option<String>,
    key: String,
    owner: String,
    access: Access,
}

fn leases() -> &'static Mutex<Vec<Lease>> {
    static LEASES: OnceLock<Mutex<Vec<Lease>>> = OnceLock::new();
    LEASES.get_or_init(Default::default)
}

fn key(server: Option<&str>, path: &str) -> String {
    let local = std::path::Path::new(path);
    // Only a path on this machine can be resolved against its filesystem.
    let resolved = if server.is_none()
        && local.is_absolute()
        && (path.contains(':') || path.starts_with("\\\\"))
    {
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

fn overlaps(a: &str, b: &str) -> bool {
    a.is_empty()
        || b.is_empty()
        || a == b
        || a.starts_with(&format!("{b}/"))
        || b.starts_with(&format!("{a}/"))
}

pub struct Reservation(u64);
impl Reservation {
    /// Leases a local path for writing.
    pub fn acquire(path: &str) -> anyhow::Result<Self> {
        Self::lease(None, path, Access::Write)
    }

    pub fn acquire_local(path: &str, access: Access) -> anyhow::Result<Self> {
        Self::lease(None, path, access)
    }

    /// Leases a path on the server `connection_id` is connected to.
    pub async fn acquire_remote(
        sessions: &Sessions,
        connection_id: &str,
        path: &str,
        access: Access,
    ) -> anyhow::Result<Self> {
        let server = sessions.server_for(connection_id).await;
        Self::lease(Some(server), path, access)
    }

    fn lease(server: Option<String>, path: &str, access: Access) -> anyhow::Result<Self> {
        let key = key(server.as_deref(), path);
        let owner = OWNER
            .try_with(Clone::clone)
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
        let mut active = leases().lock().unwrap();
        let taken = active.iter().any(|other| {
            other.owner != owner
                && other.server == server
                && (access == Access::Write || other.access == Access::Write)
                && overlaps(&other.key, &key)
        });
        if taken {
            return Err(CommandError::new(
                ErrorCode::Busy,
                format!("Another operation is already using {path}"),
            )
            .into());
        }
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        active.push(Lease {
            id,
            server,
            key,
            owner,
            access,
        });
        Ok(Self(id))
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        leases().lock().unwrap().retain(|lease| lease.id != self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(name: &str) -> String {
        format!("/reservation-test-{}/{name}", uuid::Uuid::new_v4())
    }

    #[test]
    fn tabs_cannot_reserve_aliases_of_the_same_target() {
        let first = Reservation::acquire("/reservation-test/Report.txt").unwrap();
        assert!(Reservation::acquire("/reservation-test/./report.txt").is_err());
        drop(first);
        assert!(Reservation::acquire("/reservation-test/report.txt").is_ok());
    }

    #[test]
    fn the_same_remote_path_on_two_servers_is_two_places() {
        let path = unique("report.txt");
        let _first = Reservation::lease(Some("server-a".into()), &path, Access::Write).unwrap();
        assert!(Reservation::lease(Some("server-b".into()), &path, Access::Write).is_ok());
        assert!(Reservation::lease(None, &path, Access::Write).is_ok());
        assert!(Reservation::lease(Some("server-a".into()), &path, Access::Write).is_err());
    }

    #[test]
    fn readers_share_a_place_that_a_writer_needs_to_itself() {
        let folder = unique("folder");
        let first = Reservation::acquire_local(&folder, Access::Read).unwrap();
        let second = Reservation::acquire_local(&folder, Access::Read).unwrap();
        let Err(error) = Reservation::acquire(&format!("{folder}/inside")) else {
            panic!("a writer got into a folder being read");
        };
        assert_eq!(CommandError::from(error).code, ErrorCode::Busy);
        drop((first, second));
        let writer = Reservation::acquire_local(&folder, Access::Write).unwrap();
        assert!(Reservation::acquire_local(&folder, Access::Read).is_err());
        drop(writer);
    }

    #[tokio::test]
    async fn a_child_lease_ending_leaves_its_owners_root_lease_in_place() {
        let folder = unique("folder");
        let owner = format!("walk-{}", uuid::Uuid::new_v4());
        let root = OWNER
            .scope(owner, async {
                let root = Reservation::acquire_local(&folder, Access::Write).unwrap();
                drop(Reservation::acquire(&format!("{folder}/file")).unwrap());
                root
            })
            .await;
        assert!(Reservation::acquire_local(&folder, Access::Read).is_err());
        drop(root);
        assert!(Reservation::acquire_local(&folder, Access::Read).is_ok());
    }

    #[tokio::test]
    async fn without_a_session_each_connection_stands_for_its_own_server() {
        let sessions = Sessions::default();
        let path = unique("report.txt");
        let _first = Reservation::acquire_remote(&sessions, "connection-a", &path, Access::Write)
            .await
            .unwrap();
        assert!(
            Reservation::acquire_remote(&sessions, "connection-b", &path, Access::Write)
                .await
                .is_ok()
        );
        assert!(
            Reservation::acquire_remote(&sessions, "connection-a", &path, Access::Write)
                .await
                .is_err()
        );
    }
}
