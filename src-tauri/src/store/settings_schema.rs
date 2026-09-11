use super::JsonMap;

pub(crate) fn validate_settings(patch: &JsonMap, allow_secrets: bool) -> Result<(), String> {
    let schema: JsonMap =
        serde_json::from_str(include_str!("../../../src/shared/settingsDefaults.json"))
            .expect("settings import schema must be valid");
    for (key, value) in patch {
        if allow_secrets && matches!(key.as_str(), "proxyPassword" | "removeProxyPassword") {
            if (key == "proxyPassword" && value.as_str().is_some_and(|s| s.len() <= 4096))
                || (key == "removeProxyPassword" && value.is_boolean())
            {
                continue;
            }
            return Err(format!("settings.{key}: invalid secret field"));
        }
        if matches!(
            key.as_str(),
            "proxyPassword"
                | "proxyPasswordEnc"
                | "proxyPasswordPlain"
                | "proxyPasswordSet"
                | "removeProxyPassword"
        ) {
            return Err(format!("settings.{key}: secret fields cannot be imported"));
        }
        let Some(expected) = schema.get(key) else {
            return Err(format!("settings.{key}: unknown field"));
        };
        let same_type = matches!(
            (expected, value),
            (serde_json::Value::String(_), serde_json::Value::String(_))
                | (serde_json::Value::Bool(_), serde_json::Value::Bool(_))
                | (serde_json::Value::Number(_), serde_json::Value::Number(_))
                | (serde_json::Value::Object(_), serde_json::Value::Object(_))
                | (serde_json::Value::Array(_), serde_json::Value::Array(_))
                | (
                    serde_json::Value::Null,
                    serde_json::Value::Null | serde_json::Value::Object(_)
                )
        );
        if !same_type {
            return Err(format!("settings.{key}: invalid type"));
        }
        if value.as_str().is_some_and(|text| text.len() > 4096) {
            return Err(format!("settings.{key}: text exceeds 4096 bytes"));
        }
    }
    if patch.get("recentSiteIds").is_some_and(|value| {
        !value.as_array().is_some_and(|ids| {
            ids.iter().all(|id| {
                id.as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 4096)
            })
        })
    }) {
        return Err("settings.recentSiteIds: invalid site identifiers".into());
    }
    let bounded = [
        ("interfaceScale", 50, 300),
        ("concurrency", 0, 128),
        ("connectTimeout", 0, 86_400_000),
        ("proxyPort", 1, 65_535),
        ("vaultAutoLockMinutes", 0, 10_080),
        ("transferSpeedLimitKBps", 0, 1_000_000_000),
        ("transferQueueHeight", 0, 100_000),
        ("logPanelHeight", 0, 100_000),
    ];
    for (key, min, max) in bounded {
        if let Some(value) = patch.get(key)
            && !value.as_i64().is_some_and(|n| (min..=max).contains(&n))
        {
            return Err(format!("settings.{key}: value is out of range"));
        }
    }
    for key in ["splitRatio", "transferLogSplitRatio"] {
        if patch
            .get(key)
            .is_some_and(|value| !value.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)))
        {
            return Err(format!("settings.{key}: invalid ratio"));
        }
    }
    fn columns(value: &serde_json::Value) -> bool {
        value.as_array().is_some_and(|values| {
            values.len() <= 32
                && values
                    .iter()
                    .all(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128))
        })
    }
    fn widths(value: &serde_json::Value) -> bool {
        value.as_object().is_some_and(|values| {
            values.len() <= 64
                && values.iter().all(|(key, value)| {
                    key.len() <= 128
                        && value
                            .as_f64()
                            .is_some_and(|n| (0.0..=100_000.0).contains(&n))
                })
        })
    }
    for (key, validator) in [
        ("localColumns", columns as fn(&serde_json::Value) -> bool),
        ("remoteColumns", columns),
        ("localColumnWidths", widths),
        ("remoteColumnWidths", widths),
    ] {
        if let Some(value) = patch.get(key)
            && !value.as_object().is_some_and(|panes| {
                panes
                    .iter()
                    .all(|(pane, value)| matches!(pane.as_str(), "a" | "b") && validator(value))
            })
        {
            return Err(format!("settings.{key}: invalid pane layout"));
        }
    }
    if patch
        .get("transferHiddenColumns")
        .is_some_and(|v| !columns(v))
        || patch
            .get("transferColumnOrder")
            .is_some_and(|v| !columns(v))
        || patch
            .get("transferColumnWidths")
            .is_some_and(|v| !widths(v))
    {
        return Err("settings: invalid transfer columns".into());
    }
    for (key, allowed) in [
        ("theme", &["dark", "light", "system"][..]),
        ("overwriteAction", &["ask", "skip", "overwrite"][..]),
        ("proxyType", &["socks4", "socks5", "http"][..]),
        ("paneOrientation", &["horizontal", "vertical"][..]),
    ] {
        if patch
            .get(key)
            .is_some_and(|value| !value.as_str().is_some_and(|s| allowed.contains(&s)))
        {
            return Err(format!("settings.{key}: unsupported value"));
        }
    }
    for key in ["openWithAssociations", "keyboardShortcuts"] {
        if let Some(value) = patch.get(key).and_then(serde_json::Value::as_object)
            && (value.len() > 1024
                || value.iter().any(|(key, value)| {
                    key.len() > 256 || value.as_str().is_none_or(|s| s.len() > 4096)
                }))
        {
            return Err(format!("settings.{key}: invalid string map"));
        }
    }
    if let Some(bounds) = patch
        .get("windowBounds")
        .and_then(serde_json::Value::as_object)
        && (bounds.len() != 4
            || bounds.iter().any(|(key, value)| {
                !matches!(key.as_str(), "x" | "y" | "width" | "height")
                    || !value.as_f64().is_some_and(|n| {
                        n.is_finite()
                            && n.abs() <= 100_000.0
                            && (!matches!(key.as_str(), "width" | "height") || n > 0.0)
                    })
            }))
    {
        return Err("settings.windowBounds: invalid bounds".into());
    }
    if patch
        .get("proxyEnabled")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        && (!allow_secrets || patch.contains_key("proxyHost"))
    {
        let host = patch
            .get("proxyHost")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if host.trim().is_empty() {
            return Err("settings.proxyHost: required when proxy is enabled".into());
        }
        if patch
            .get("proxyType")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|kind| !matches!(kind, "socks4" | "socks5" | "http"))
        {
            return Err("settings.proxyType: unsupported proxy type".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_sites_can_be_saved_and_imported() {
        for allow_secrets in [false, true] {
            for value in [
                serde_json::json!([]),
                serde_json::json!(["site-a", "site-b"]),
            ] {
                let patch = serde_json::json!({"recentSiteIds": value});
                assert!(validate_settings(patch.as_object().unwrap(), allow_secrets).is_ok());
            }
            for value in [
                serde_json::json!([42]),
                serde_json::json!([""]),
                serde_json::json!("site-a"),
            ] {
                let patch = serde_json::json!({"recentSiteIds": value});
                assert!(validate_settings(patch.as_object().unwrap(), allow_secrets).is_err());
            }
        }
    }
    #[test]
    fn ipc_and_import_share_integer_ranges_and_zero_semantics() {
        for allow_secrets in [false, true] {
            let zeros = serde_json::json!({"concurrency":0,"connectTimeout":0});
            assert!(validate_settings(zeros.as_object().unwrap(), allow_secrets).is_ok());
            for invalid in [
                serde_json::json!({"concurrency":0.5}),
                serde_json::json!({"connectTimeout":-1}),
                serde_json::json!({"concurrency":129}),
                serde_json::json!({"unknown":true}),
                serde_json::json!({"theme":"invalid"}),
                serde_json::json!({"proxyPort":"21"}),
            ] {
                assert!(
                    validate_settings(invalid.as_object().unwrap(), allow_secrets).is_err(),
                    "{invalid}"
                );
            }
        }
    }
}
