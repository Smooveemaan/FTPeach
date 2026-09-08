//! Saved sites, folders, and their layout (single-level nesting — see
//! save_folder's own comment). Owns the secret migration to/from the
//! Stronghold vault, since that migration only ever touches sites.json.

use super::{JsonMap, Store};
use crate::domain::{Protocol, SiteLayoutEntry};
use crate::ipc::{CommandError, ErrorCode};
use crate::security::vault::{SecretUpdate, Vault};
use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use zeroize::Zeroize;

pub struct SaveSiteOutcome {
    pub id: String,
    pub secret_not_persisted: bool,
}

const MAX_SITE_STRING_LEN: usize = 4096;

fn validate_name(name: &str, empty_message: &str, too_long_message: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        anyhow::bail!(CommandError::new(ErrorCode::InvalidInput, empty_message));
    }
    if trimmed.chars().count() > MAX_SITE_STRING_LEN {
        anyhow::bail!(CommandError::new(ErrorCode::InvalidInput, too_long_message));
    }
    Ok(())
}

pub(crate) fn validate_site_input(input: &JsonMap) -> Result<()> {
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    validate_name(name, "Site name is required", "Site name is too long")?;

    if input.get("kind").and_then(Value::as_str) == Some("local") {
        let local_path = input
            .get("localPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if local_path.is_empty() || local_path.chars().count() > MAX_SITE_STRING_LEN {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "A valid local folder path is required",
            ));
        }
        return Ok(());
    }

    let protocol_raw = input.get("protocol").and_then(Value::as_str).unwrap_or("");
    let protocol: Protocol = serde_json::from_value(Value::String(protocol_raw.to_string()))
        .map_err(|_| {
            anyhow::Error::new(CommandError::new(
                ErrorCode::InvalidInput,
                format!("Unsupported protocol: {protocol_raw}"),
            ))
        })?;

    if matches!(protocol, Protocol::Webdav) {
        let webdav_url = input
            .get("webdavUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if webdav_url.is_empty() {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "WebDAV URL is required",
            ));
        }
        if webdav_url.chars().count() > MAX_SITE_STRING_LEN {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "WebDAV URL is too long",
            ));
        }
    } else {
        let host = input
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if host.is_empty() {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "Host is required",
            ));
        }
        if host.chars().count() > MAX_SITE_STRING_LEN {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "Host is too long",
            ));
        }
    }

    if let Some(port) = input.get("port")
        && !port.is_null()
    {
        let in_range = port
            .as_u64()
            .is_some_and(|value| (1..=65535).contains(&value));
        if !in_range {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "Port must be between 1 and 65535",
            ));
        }
    }

    for key in [
        "user",
        "remotePath",
        "keyPath",
        "caCertPath",
        "icon",
        "color",
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str)
            && value.chars().count() > MAX_SITE_STRING_LEN
        {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                format!("{key} is too long"),
            ));
        }
    }

    Ok(())
}

// Reads a renderer-supplied `parentId` value as `None` (root) or a folder
// id, rejecting anything that isn't a JSON string or null outright.
fn parse_parent_id(value: Option<&Value>) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => anyhow::bail!(CommandError::new(
            ErrorCode::InvalidInput,
            "parentId must be a string or null",
        )),
    }
}

/// Whether `entry` belongs in `local_paths_file()` rather than `sites_file()`.
pub(super) fn is_local_scope_entry(entry: &JsonMap) -> bool {
    match entry.get("kind").and_then(Value::as_str) {
        Some("local") => true,
        Some("folder") => entry.get("managerScope").and_then(Value::as_str) == Some("localPaths"),
        _ => false,
    }
}

fn validate_parent<'a>(
    entries: impl IntoIterator<Item = &'a JsonMap> + Clone,
    entry_id: &str,
    entry_kind: Option<&str>,
    parent_id: Option<&str>,
) -> Result<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if entry_kind == Some("folder") {
        anyhow::bail!(CommandError::new(
            ErrorCode::InvalidInput,
            "Folders cannot be nested",
        ));
    }
    if parent_id == entry_id {
        anyhow::bail!(CommandError::new(
            ErrorCode::InvalidInput,
            "An entry cannot be its own parent",
        ));
    }
    match entries
        .into_iter()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(parent_id))
    {
        None => anyhow::bail!(CommandError::new(
            ErrorCode::NotFound,
            format!("Parent folder not found: {parent_id}"),
        )),
        Some(parent) if parent.get("kind").and_then(Value::as_str) != Some("folder") => {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                format!("Parent entry is not a folder: {parent_id}"),
            ))
        }
        Some(_) => Ok(()),
    }
}

mod mutations;
mod queries;
