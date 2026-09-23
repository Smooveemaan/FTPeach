//! Tab restore state across restarts. The renderer owns the UI semantics, but
//! the backend enforces a narrow persistence schema so tabs.json cannot become
//! an accidental storage channel for passwords or other renderer secrets.
use super::Store;
use crate::ipc::{CommandError, ErrorCode};
use anyhow::Result;
use serde_json::{Value, json};
use std::path::PathBuf;

/// Most tabs a saved session keeps.
const MAX_TABS: usize = 256;
/// Longest tab or site id kept, in bytes.
const MAX_ID_LEN: usize = 128;
/// Longest tab name kept, in bytes.
const MAX_NAME_LEN: usize = 1024;
/// Longest pane path kept, in bytes: a Windows long path in UTF-8.
const MAX_PATH_LEN: usize = 32_767 * 3;

impl Store {
    fn tabs_file(&self) -> PathBuf {
        self.dir.join("tabs.json")
    }

    pub async fn get_tabs(&self) -> Value {
        sanitize_tabs_state(
            self.read_json(
                &self.tabs_file(),
                json!({"activeTabId": Value::Null, "tabs": []}),
            )
            .await,
        )
        .0
    }

    /// Stores the session, refusing one over the limits instead of quietly
    /// saving less than the renderer asked for.
    pub async fn set_tabs(&self, data: Value) -> Result<()> {
        let (clean, trimmed) = sanitize_tabs_state(data);
        if trimmed {
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                format!(
                    "The session is too large to save (at most {MAX_TABS} tabs, ids up to \
                     {MAX_ID_LEN} bytes, names up to {MAX_NAME_LEN} bytes)"
                ),
            )
            .into());
        }
        let path = self.tabs_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        self.write_json(&path, &clean).await
    }

    pub async fn clear_tabs(&self) -> Result<()> {
        self.set_tabs(json!({"activeTabId": Value::Null, "tabs": []}))
            .await
    }
}

/// Tabs are renderer-owned UI state, not a general JSON persistence channel.
/// Rebuild the small supported schema so passwords (including future or
/// compromised-renderer fields) can neither be written to nor read back from
/// tabs.json. A repeated tab id is dropped, and an active id naming no kept
/// tab becomes null. The flag says whether anything was cut to fit the
/// limits.
fn sanitize_tabs_state(data: Value) -> (Value, bool) {
    let mut trimmed = false;
    let mut ids = std::collections::HashSet::new();
    let mut tabs = Vec::new();
    for tab in data
        .get("tabs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(source) = tab.as_object() else {
            continue;
        };
        if tabs.len() == MAX_TABS {
            trimmed = true;
            break;
        }
        let mut clean = serde_json::Map::new();
        trimmed |= copy_string(source, &mut clean, "id", MAX_ID_LEN);
        if let Some(id) = clean.get("id").and_then(Value::as_str)
            && !ids.insert(id.to_owned())
        {
            continue;
        }
        trimmed |= copy_string(source, &mut clean, "name", MAX_NAME_LEN);
        copy_bool(source, &mut clean, "syncBrowsing");
        if let Some(panes) = source.get("panes").and_then(Value::as_object) {
            let mut clean_panes = serde_json::Map::new();
            for pane_id in ["a", "b"] {
                let Some(pane) = panes.get(pane_id).and_then(Value::as_object) else {
                    continue;
                };
                let mut clean_pane = serde_json::Map::new();
                trimmed |= copy_string(pane, &mut clean_pane, "kind", MAX_ID_LEN);
                trimmed |= copy_string(pane, &mut clean_pane, "path", MAX_PATH_LEN);
                trimmed |= copy_string(pane, &mut clean_pane, "siteId", MAX_ID_LEN);
                clean_panes.insert(pane_id.into(), Value::Object(clean_pane));
            }
            clean.insert("panes".into(), Value::Object(clean_panes));
        }
        tabs.push(Value::Object(clean));
    }
    let active_tab_id = data
        .get("activeTabId")
        .and_then(Value::as_str)
        .filter(|id| ids.contains(*id))
        .map_or(Value::Null, |id| Value::String(id.to_owned()));
    (json!({"activeTabId": active_tab_id, "tabs": tabs}), trimmed)
}

/// Copies `key` when it is a string of at most `limit` bytes; returns
/// whether a longer one was left out.
fn copy_string(
    source: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
    limit: usize,
) -> bool {
    match source.get(key).and_then(Value::as_str) {
        Some(value) if value.len() > limit => true,
        Some(value) => {
            target.insert(key.into(), Value::String(value.to_owned()));
            false
        }
        None => false,
    }
}

fn copy_bool(
    source: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source.get(key).and_then(Value::as_bool) {
        target.insert(key.into(), Value::Bool(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_tab_state_keeps_only_the_ui_schema_and_drops_secrets() {
        let state = json!({
            "activeTabId": "tab-1",
            "password": "top-level-secret",
            "tabs": [{
                "id": "tab-1",
                "name": "Remote",
                "password": "tab-secret",
                "panes": {
                    "a": {"kind": "remote", "siteId": "site-1", "path": "/", "password": "secret"},
                    "b": {"kind": "local", "path": "C:\\Temp", "keyPassphrase": "secret"}
                }
            }]
        });

        let clean = sanitize_tabs_state(state).0;
        let serialized = serde_json::to_string(&clean).unwrap();

        assert_eq!(clean["activeTabId"], "tab-1");
        assert_eq!(clean["tabs"][0]["panes"]["a"]["siteId"], "site-1");
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("keyPassphrase"));
    }

    #[test]
    fn repeated_ids_and_a_dangling_active_id_are_normalised() {
        let (clean, trimmed) = sanitize_tabs_state(json!({
            "activeTabId": "gone",
            "tabs": [{"id": "t1", "name": "first"}, {"id": "t1", "name": "copy"}, "junk", {"id": "t2"}]
        }));
        assert!(!trimmed);
        assert_eq!(clean["activeTabId"], Value::Null);
        assert_eq!(clean["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(clean["tabs"][0]["name"], "first");
    }

    #[test]
    fn oversized_sessions_are_cut_on_read_and_refused_on_write() {
        let many: Vec<Value> = (0..MAX_TABS + 1)
            .map(|n| json!({"id": format!("t{n}")}))
            .collect();
        let (clean, trimmed) = sanitize_tabs_state(json!({"tabs": many}));
        assert!(trimmed);
        assert_eq!(clean["tabs"].as_array().unwrap().len(), MAX_TABS);

        let long_name = json!({"tabs": [{"id": "t", "name": "x".repeat(MAX_NAME_LEN + 1)}]});
        let (clean, trimmed) = sanitize_tabs_state(long_name.clone());
        assert!(trimmed);
        assert_eq!(clean["tabs"][0].get("name"), None);

        let dir = std::env::temp_dir().join(format!("ftpeach-tabs-{}", uuid::Uuid::new_v4()));
        let store = Store::new_at(dir.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime.block_on(store.set_tabs(long_name)).unwrap_err();
        assert_eq!(
            CommandError::from_anyhow(&error).code,
            ErrorCode::ResourceLimit
        );
        assert!(!dir.join("tabs.json").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
