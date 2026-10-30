//! Build-time application configuration shared by storage and filesystem guards.

/// The CLI exposes its `--config` merge patch to rustc as `TAURI_CONFIG`.
/// Read the same override as `generate_context!` without embedding a second Context.
pub(crate) fn identifier() -> String {
    identifier_from_merge(option_env!("TAURI_CONFIG"))
}

fn identifier_from_merge(merge: Option<&str>) -> String {
    let base: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("the base Tauri configuration is valid JSON");
    let merge = merge.map(|text| {
        serde_json::from_str::<serde_json::Value>(text)
            .expect("the Tauri configuration merge is valid JSON")
    });
    merge
        .as_ref()
        .and_then(|config| config["identifier"].as_str())
        .or_else(|| base["identifier"].as_str())
        .expect("the Tauri configuration names an identifier")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::identifier_from_merge;

    #[test]
    fn development_config_changes_the_data_folder_identifier() {
        assert_eq!(
            identifier_from_merge(Some(include_str!("../tauri.dev.conf.json"))),
            "com.smooveemaan.ftpeach.dev"
        );
    }
}
