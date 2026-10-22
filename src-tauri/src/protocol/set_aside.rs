//! Replacing a file on a server that will not rename over one: the old file
//! is renamed aside first, and put back if the new one cannot take its place.
//! A replacement cut off between its two renames is remembered, on disk once
//! no connection is left to finish it, so the next one to that server can.
use super::{BackendResult, ProtocolBackend, fail};
use serde::Serialize;
use std::path::Path;

/// Puts `old_path` in place of the file at `new_path` on a server that will
/// not rename over an existing file. That file is renamed aside to a hidden
/// sibling rather than deleted, so one version stands at a name at every
/// step: if the new file cannot take its place, the old one is put back, and
/// it is removed only once the new one is in. A stop or a lost connection
/// between the two renames leaves it under the hidden name, recorded for
/// [`put_back_set_aside`].
pub(crate) async fn replace_by_setting_aside<B: ProtocolBackend + ?Sized>(
    backend: &mut B,
    old_path: &str,
    new_path: &str,
) -> BackendResult<()> {
    let parent = new_path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(".");
    let aside = format!("{parent}/.ftpeach-{}.old", uuid::Uuid::new_v4());
    if let Err(error) = backend.rename_no_replace(new_path, &aside).await {
        return Err(refused_replacement(error, new_path));
    }
    SET_ASIDE.lock().unwrap().insert(
        old_path.to_owned(),
        SetAside {
            aside: aside.clone(),
            name: new_path.to_owned(),
            stranded_on: None,
        },
    );
    let settled = || settle(old_path);
    let Err(error) = backend.rename_no_replace(old_path, new_path).await else {
        settled();
        if let Err(error) = backend.remove(&aside, false).await {
            log::warn!(
                "Replaced {new_path}, but could not remove its previous version {aside}: {error:#}"
            );
        }
        return Ok(());
    };
    if let Err(restore) = backend.rename_no_replace(&aside, new_path).await {
        log::error!("Could not put {aside} back as {new_path}: {restore:#}");
        return Err(error.context(format!(
            "The previous version of {new_path} is kept as {aside}"
        )));
    }
    settled();
    Err(refused_replacement(error, new_path))
}

/// A replacement that stopped between its two renames, by the file that was to
/// take the name.
struct SetAside {
    /// The hidden name the old file was given.
    aside: String,
    /// The name it is to go back to.
    name: String,
    /// The server, once no connection there could put it back: the next one
    /// to it does.
    stranded_on: Option<String>,
}

// ponytail: process-wide map keyed by remote path. Only stranded entries are
// kept on disk; a crash between the two renames themselves still leaves the
// old file under its hidden name.
static SET_ASIDE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, SetAside>>,
> = std::sync::LazyLock::new(Default::default);

/// Where stranded replacements are kept while FTPeach is closed.
static STRANDED_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// How many stranded replacements a file kept between runs may name.
const MAX_STRANDED: usize = 1024;

/// A stranded replacement as it is kept between runs.
#[derive(Serialize, serde::Deserialize)]
struct Stranded {
    server: String,
    staging: String,
    aside: String,
    name: String,
}

impl Stranded {
    /// Only what a replacement itself would have written: a staging file and
    /// a set-aside file of FTPeach's own naming, both beside the name. A record
    /// that names anything else would rename or delete a file FTPeach did not
    /// make.
    fn is_own(&self) -> bool {
        let split = |path: &str| {
            path.rsplit_once('/')
                .map(|(parent, base)| (parent.to_owned(), base.to_owned()))
        };
        let own = |base: &str, suffix: &str| {
            base.strip_prefix(".ftpeach-")
                .and_then(|rest| rest.strip_suffix(suffix))
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        };
        let (Some((parent, _)), Some((staging_parent, staging)), Some((aside_parent, aside))) =
            (split(&self.name), split(&self.staging), split(&self.aside))
        else {
            return false;
        };
        parent == staging_parent
            && parent == aside_parent
            && own(&staging, ".part")
            && own(&aside, ".old")
    }
}

/// Keeps replacements left for the next connection in `data_dir`, and takes
/// back those an earlier run left there, so closing FTPeach before that
/// connection does not lose the way back to a set-aside file.
pub fn keep_stranded_in(data_dir: &Path) {
    let path = data_dir.join("stranded-replacements.json");
    load_stranded(&path);
    let _ = STRANDED_FILE.set(path);
}

fn load_stranded(path: &Path) {
    let records: Vec<Stranded> = match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(records) => records,
            Err(error) => {
                log::warn!("Ignored {}: {error}", path.display());
                return;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!("Could not read {}: {error}", path.display());
            return;
        }
    };
    let mut map = SET_ASIDE.lock().unwrap();
    for record in records.into_iter().take(MAX_STRANDED) {
        if !record.is_own() {
            log::warn!(
                "Ignored a stranded replacement of {} that names files FTPeach did not make",
                record.name
            );
            continue;
        }
        map.entry(record.staging).or_insert(SetAside {
            aside: record.aside,
            name: record.name,
            stranded_on: Some(record.server),
        });
    }
}

fn write_stranded(path: &Path) -> std::io::Result<()> {
    let records: Vec<Stranded> = SET_ASIDE
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(staging, entry)| {
            Some(Stranded {
                server: entry.stranded_on.clone()?,
                staging: staging.clone(),
                aside: entry.aside.clone(),
                name: entry.name.clone(),
            })
        })
        .take(MAX_STRANDED)
        .collect();
    if records.is_empty() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&records)?)?;
    std::fs::rename(&tmp, path)
}

/// Brings the kept stranded replacements up to date with the map.
fn save_stranded() {
    // One writer at a time, so an older snapshot never lands after a newer one.
    static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if let Some(path) = STRANDED_FILE.get() {
        let _saving = SAVING.lock().unwrap();
        if let Err(error) = write_stranded(path) {
            log::warn!(
                "Could not keep stranded replacements in {}: {error}",
                path.display()
            );
        }
    }
}

/// Forgets the replacement by `staging`, on disk too when it was stranded.
fn settle(staging: &str) -> Option<SetAside> {
    let entry = SET_ASIDE.lock().unwrap().remove(staging);
    if entry
        .as_ref()
        .is_some_and(|entry| entry.stranded_on.is_some())
    {
        save_stranded();
    }
    entry
}

/// Before `staging` is deleted: puts back the file a replacement by it set
/// aside and did not get to put back itself, over a connection that still
/// works. False when that failed: the staging file has to stay, since it may be
/// the only copy of the new version while the old one is still hidden. The
/// record stays for another try, unless something else has taken the name.
pub(crate) async fn put_back_set_aside<B: ProtocolBackend + ?Sized>(
    backend: &mut B,
    staging: &str,
) -> bool {
    let Some((aside, name)) = SET_ASIDE
        .lock()
        .unwrap()
        .get(staging)
        .map(|entry| (entry.aside.clone(), entry.name.clone()))
    else {
        return true;
    };
    let put_back = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        backend.rename_no_replace(&aside, &name),
    )
    .await;
    match put_back {
        Ok(Ok(())) => {
            settle(staging);
            log::warn!("Put {aside} back as {name}: replacing it with {staging} was cut off");
            return true;
        }
        Ok(Err(error))
            if crate::ipc::CommandError::from_anyhow(&error).code
                == crate::ipc::ErrorCode::AlreadyExists =>
        {
            settle(staging);
            log::error!("{name} is taken again; kept its previous version {aside} and {staging}");
        }
        Ok(Err(error))
            if crate::ipc::CommandError::from_anyhow(&error).code
                == crate::ipc::ErrorCode::NotFound =>
        {
            settle(staging);
            log::error!(
                "{aside} is gone, so there is nothing to put back as {name}; kept {staging}"
            );
        }
        Ok(Err(error)) => {
            log::error!("Could not put {aside} back as {name}, kept it and {staging}: {error:#}");
        }
        Err(_) => log::error!("Timed out putting {aside} back as {name}, kept it and {staging}"),
    }
    false
}

/// Once cleanup has had its try: marks a file `staging` set aside that is
/// still waiting to be put back as left on `server`, for the next connection
/// there. Says whether there is one.
pub(crate) fn strand_set_aside(staging: &str, server: &str) -> bool {
    let stranded = SET_ASIDE
        .lock()
        .unwrap()
        .get_mut(staging)
        .map(|entry| entry.stranded_on = Some(server.to_owned()))
        .is_some();
    if stranded {
        save_stranded();
    }
    stranded
}

/// The staging files whose set-aside file waits on `server` to be put back.
pub(crate) fn stranded_on(server: &str) -> Vec<String> {
    SET_ASIDE
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry.stranded_on.as_deref() == Some(server))
        .map(|(staging, _)| staging.clone())
        .collect()
}

/// After `staging` has taken its name: removes the file it replaced that an
/// earlier attempt set aside, when a pause came between the two renames.
pub(crate) async fn remove_set_aside<B: ProtocolBackend + ?Sized>(backend: &mut B, staging: &str) {
    let Some(entry) = settle(staging) else {
        return;
    };
    if let Err(error) = backend.remove(&entry.aside, false).await {
        log::warn!(
            "Replaced {}, but could not remove its previous version {}: {error:#}",
            entry.name,
            entry.aside
        );
    }
}

/// A refusal the server gave no reason for is named for what it refused.
fn refused_replacement(error: anyhow::Error, new_path: &str) -> anyhow::Error {
    if !crate::ipc::CommandError::unexplained(&error) {
        return error;
    }
    fail(
        crate::ipc::ErrorCode::ReplaceUnsupported,
        format!("The server did not let {new_path} be replaced: {error:#}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stranded_replacement_outlives_a_restart_and_a_foreign_record_does_not() {
        let dir = std::env::temp_dir().join(format!("ftpeach-stranded-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stranded-replacements.json");
        let server = format!("server {}", uuid::Uuid::new_v4());
        let staging = format!("/up/.ftpeach-{}.part", uuid::Uuid::new_v4());
        let aside = format!("/up/.ftpeach-{}.old", uuid::Uuid::new_v4());
        SET_ASIDE.lock().unwrap().insert(
            staging.clone(),
            SetAside {
                aside: aside.clone(),
                name: "/up/file".into(),
                stranded_on: None,
            },
        );
        assert!(strand_set_aside(&staging, &server));
        write_stranded(&path).unwrap();

        // The next run starts with an empty map.
        SET_ASIDE.lock().unwrap().remove(&staging);
        load_stranded(&path);
        assert_eq!(stranded_on(&server), std::slice::from_ref(&staging));
        assert_eq!(SET_ASIDE.lock().unwrap()[&staging].aside, aside);

        // Settled, it leaves the file; the last one takes the file with it.
        SET_ASIDE.lock().unwrap().remove(&staging);
        write_stranded(&path).unwrap();
        let left: Vec<Stranded> = std::fs::read(&path)
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
            .unwrap_or_default();
        assert!(left.iter().all(|record| record.staging != staging));

        // A record that would rename or delete someone else's file is dropped.
        let foreign = serde_json::json!([
            { "server": server, "staging": "/up/report.pdf", "aside": aside, "name": "/up/file" },
            { "server": server, "staging": staging, "aside": "/other/.ftpeach-x.old", "name": "/up/file" },
        ]);
        std::fs::write(&path, foreign.to_string()).unwrap();
        load_stranded(&path);
        assert!(stranded_on(&server).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
