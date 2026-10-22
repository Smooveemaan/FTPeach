//! Recursive operation contracts and common outcome checks.
use crate::ipc::{CommandError, ErrorCode};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio_util::sync::CancellationToken;

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Endpoint {
    Local {
        path: String,
    },
    Remote {
        path: String,
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
}
impl Endpoint {
    pub(super) fn path(&self, relative: &str) -> String {
        match self {
            Self::Local { path } => Path::new(path)
                .join(relative)
                .to_string_lossy()
                .into_owned(),
            Self::Remote { path, .. } => {
                if relative.is_empty() {
                    path.clone()
                } else {
                    format!("{}/{relative}", path.trim_end_matches('/'))
                }
            }
        }
    }
    pub(super) fn connection(&self) -> &str {
        match self {
            Self::Local { .. } => "",
            Self::Remote { connection_id, .. } => connection_id,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub id: String,
    pub source: Endpoint,
    pub target: Endpoint,
    pub moving: bool,
    pub overwrite: bool,
    #[serde(default)]
    pub skip_existing: bool,
    /// The paused attempt this one carries on from. Its journal says what is
    /// already in place, so this attempt copies only the rest.
    #[serde(default)]
    pub resume_from: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ok: bool,
    pub outcome: String,
    pub completed: usize,
    pub skipped: usize,
    pub scanned: usize,
    /// Folders made and files delivered on the target, earlier attempts included.
    pub landed: usize,
    pub errors: Vec<CommandError>,
    /// The walk was paused and kept its journal for the next attempt.
    pub paused: bool,
    /// A move copied everything, but removing its originals stopped at this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_not_removed: Option<String>,
}

/// Names the path a failure happened at, classified first: a path such as
/// `/photos/2401/` must not read as a failed login.
pub(super) fn at_path(error: anyhow::Error, path: String) -> anyhow::Error {
    let mut typed = CommandError::from_anyhow(&error);
    typed.details = Some(format!(
        "{path}: {}",
        typed.details.as_deref().unwrap_or(&typed.message)
    ));
    typed.into()
}

pub(super) fn check_cancel(token: &CancellationToken) -> Result<()> {
    if token.is_cancelled() {
        return Err(
            CommandError::new(ErrorCode::Cancelled, "Recursive operation cancelled").into(),
        );
    }
    Ok(())
}
