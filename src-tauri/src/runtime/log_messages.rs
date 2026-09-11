//! English text for the translated protocol-log events.
//!
//! Backends report human-authored sentences as an i18n key plus parameters,
//! and the log panel translates them into the interface language. The log file
//! and the diagnostic bundle are read outside the app, so they get the English
//! sentence instead of `connecting {"addr":…}`. The text comes from the same
//! `en.json` the renderer uses, so there is one copy of every sentence.

use serde_json::{Map, Value};
use std::sync::OnceLock;

fn messages() -> &'static Map<String, Value> {
    static MESSAGES: OnceLock<Map<String, Value>> = OnceLock::new();
    MESSAGES.get_or_init(|| {
        serde_json::from_str::<Value>(include_str!("../../../src/i18n/locales/en.json"))
            .ok()
            .and_then(|locale| locale.get("log").and_then(Value::as_object).cloned())
            .unwrap_or_default()
    })
}

/// The English sentence for `key`, or the key and its parameters when the
/// locale has no such sentence.
pub fn render(key: &str, params: &Value) -> String {
    let messages = messages();
    // i18next's plural forms, for the English plural rule: `_one` for exactly
    // one, `_other` for everything else.
    let plural = params
        .get("count")
        .and_then(Value::as_f64)
        .map(|count| format!("{key}_{}", if count == 1.0 { "one" } else { "other" }));
    let template = plural
        .as_deref()
        .and_then(|plural_key| messages.get(plural_key))
        .or_else(|| messages.get(key))
        .and_then(Value::as_str);
    match template {
        Some(template) => interpolate(template, params),
        None => format!("{key} {params}"),
    }
}

/// Fills `{{name}}` placeholders the way i18next does; a placeholder with no
/// matching parameter stays as written.
fn interpolate(template: &str, params: &Value) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            rest = &rest[start..];
            break;
        };
        let name = after[..end].split(',').next().unwrap_or_default().trim();
        match params.get(name) {
            Some(Value::String(value)) => output.push_str(value),
            Some(Value::Null) | None => output.push_str(&rest[start..start + end + 4]),
            Some(value) => output.push_str(&value.to_string()),
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::render;
    use serde_json::json;

    #[test]
    fn renders_events_with_their_parameters() {
        assert_eq!(
            render("connecting", &json!({ "addr": "example.test:21" })),
            "Connecting to example.test:21..."
        );
        assert_eq!(render("connected", &json!({})), "Logged in.");
    }

    #[test]
    fn picks_the_english_plural_form() {
        assert_eq!(
            render("receivedEntries", &json!({ "count": 1 })),
            "Received 1 entry"
        );
        assert_eq!(
            render("receivedEntries", &json!({ "count": 12 })),
            "Received 12 entries"
        );
    }

    #[test]
    fn unknown_keys_and_missing_parameters_stay_readable() {
        assert_eq!(
            render("noSuchEvent", &json!({ "a": 1 })),
            r#"noSuchEvent {"a":1}"#
        );
        assert_eq!(
            render("connecting", &json!({})),
            "Connecting to {{addr}}..."
        );
    }
}
