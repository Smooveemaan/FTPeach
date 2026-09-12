//! Both halves of the toast's identity are spelled out in Rust but owned by
//! `tauri.conf.json`, and neither one fails loudly: a toast under a stale id,
//! or an icon that was never bundled, still shows — just as something other
//! than FTPeach. These hold the two files together.
use super::{APP_USER_MODEL_ID, ICON_RESOURCE};

fn config() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri.conf.json should be valid JSON")
}

#[test]
fn the_toast_identity_is_the_bundle_identifier() {
    assert_eq!(
        config()["identifier"].as_str(),
        Some(APP_USER_MODEL_ID),
        "the AppUserModelID must match tauri.conf.json's identifier"
    );
}

/// A prefixed path is not an error anywhere in the chain — the key takes it,
/// the file is really there, and the toast simply arrives with no icon.
#[cfg(windows)]
#[test]
fn the_icon_uri_drops_the_verbatim_prefix() {
    use std::path::Path;

    assert_eq!(
        super::icon_uri(Path::new(
            r"\\?\C:\Program Files\FTPeach\icons\app-icon.png"
        )),
        r"C:\Program Files\FTPeach\icons\app-icon.png"
    );
    assert_eq!(
        super::icon_uri(Path::new(r"C:\FTPeach\icons\app-icon.png")),
        r"C:\FTPeach\icons\app-icon.png"
    );
}

#[test]
fn the_toast_icon_ships_as_a_bundle_resource() {
    let config = config();
    let resources = config["bundle"]["resources"]
        .as_object()
        .expect("bundle.resources should be an object");

    assert!(
        resources.values().any(|target| target == ICON_RESOURCE),
        "no bundle resource is installed at {ICON_RESOURCE}, so the registered \
         notification icon would point at a missing file"
    );
}

/// The toast has to draw the app icon at tray size, and only the multi-size
/// `.ico` carries an entry drawn for it — pointed at a single large bitmap
/// instead, Windows shrinks it and the outline breaks up.
#[test]
fn the_toast_icon_is_the_app_icon_the_tray_uses() {
    let config = config();
    let source = config["bundle"]["resources"]
        .as_object()
        .expect("bundle.resources should be an object")
        .iter()
        .find(|(_, target)| target.as_str() == Some(ICON_RESOURCE))
        .map(|(source, _)| source.clone())
        .expect("the toast icon should be a bundle resource");

    assert!(
        source.ends_with(".ico"),
        "the toast icon comes from {source}; it must be the multi-resolution .ico"
    );
    assert!(
        config["bundle"]["icon"]
            .as_array()
            .expect("bundle.icon should be an array")
            .iter()
            .any(|icon| icon.as_str() == Some(source.as_str())),
        "the toast icon {source} is not listed in bundle.icon, so it is no longer \
         the icon Windows shows for FTPeach everywhere else"
    );
}
