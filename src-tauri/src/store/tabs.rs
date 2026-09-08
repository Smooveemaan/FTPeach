//! Tab restore state across restarts. The renderer owns the UI semantics, but
//! the backend enforces a narrow persistence schema so tabs.json cannot become
//! an accidental storage channel for passwords or other renderer secrets.
use super::Store;
use anyhow::Result;
use serde_json::{Value, json};
use std::path::PathBuf;

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
    }

    pub async fn set_tabs(&self, data: Value) -> Result<()> {
        let path = self.tabs_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        self.write_json(&path, &sanitize_tabs_state(data)).await
    }

    pub async fn clear_tabs(&self) -> Result<()> {
        self.set_tabs(json!({"activeTabId": Value::Null, "tabs": []}))
            .await
    }
}

/// Tabs are renderer-owned UI state, not a general JSON persistence channel.
/// Rebuild the small supported schema so passwords (including future or
/// compromised-renderer fields) can neither be written to nor read back from
/// tabs.json.
fn sanitize_tabs_state(data: Value) -> Value {
    let active_tab_id = data
        .get("activeTabId")
        .and_then(Value::as_str)
        .map_or(Value::Null, |value| Value::String(value.to_owned()));
    let tabs: Vec<Value> = data
        .get("tabs")
        .and_then(Value::as_array)
        .map(|tabs| {
            tabs.iter()
                .filter_map(|tab| {
                    let source = tab.as_object()?;
                    let mut clean = serde_json::Map::new();
                    copy_string(source, &mut clean, "id");
                    copy_string(source, &mut clean, "name");
                    copy_bool(source, &mut clean, "syncBrowsing");
                    if let Some(panes) = source.get("panes").and_then(Value::as_object) {
                        let mut clean_panes = serde_json::Map::new();
                        for pane_id in ["a", "b"] {
                            let Some(pane) = panes.get(pane_id).and_then(Value::as_object) else {
                                continue;
                            };
                            let mut clean_pane = serde_json::Map::new();
                            copy_string(pane, &mut clean_pane, "kind");
                            copy_string(pane, &mut clean_pane, "path");
                            copy_string(pane, &mut clean_pane, "siteId");
                            clean_panes.insert(pane_id.into(), Value::Object(clean_pane));
                        }
                        clean.insert("panes".into(), Value::Object(clean_panes));
                    }
                    Some(Value::Object(clean))
                })
                .collect()
        })
        .unwrap_or_default();
    json!({"activeTabId": active_tab_id, "tabs": tabs})
}

fn copy_string(
    source: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source.get(key).and_then(Value::as_str) {
        target.insert(key.into(), Value::String(value.to_owned()));
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

        let clean = sanitize_tabs_state(state);
        let serialized = serde_json::to_string(&clean).unwrap();

        assert_eq!(clean["activeTabId"], "tab-1");
        assert_eq!(clean["tabs"][0]["panes"]["a"]["siteId"], "site-1");
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("keyPassphrase"));
    }
}
