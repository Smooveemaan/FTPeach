//! Application menu bar (used on macOS).
//!
//! macOS applications require a system menu bar (NSMenu) at the top of the
//! screen. To prevent system shortcuts from conflicting with FTPeach's own
//! controls (e.g. ⌘W for closing tabs rather than the whole window, ⌘H for
//! home navigation), FTPeach installs a dedicated menu containing only
//! FTPeach, Edit, and Window submenus, without ⌘W ("Close Window") or ⌘H ("Hide").
//!
//! ⌘Q routes through [`shutdown::quit`], prompting the user if transfers or
//! unsynced edits are in progress.

use tauri::{
    AppHandle, Runtime,
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

pub const ID_APP_QUIT: &str = "app-menu-quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMenuCommand {
    Quit,
}

/// What an application menu item click asks for.
pub fn command_for(id: &str) -> Option<AppMenuCommand> {
    if id == ID_APP_QUIT {
        Some(AppMenuCommand::Quit)
    } else {
        None
    }
}

/// Builds the custom application menu:
/// - FTPeach (About, Services, Hide Others, Show All, Quit with dialog)
/// - Edit (Undo, Redo, Cut, Copy, Paste, Select All)
/// - Window (Minimize, Zoom, Bring All to Front)
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let menu = Menu::new(app)?;

    // 1. FTPeach submenu
    let app_submenu = Submenu::new(app, "FTPeach", true)?;
    app_submenu.append(&PredefinedMenuItem::about(app, None, Some(about_metadata))?)?;
    app_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    app_submenu.append(&PredefinedMenuItem::services(app, None)?)?;
    app_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    app_submenu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    app_submenu.append(&PredefinedMenuItem::show_all(app, None)?)?;
    app_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    let quit_item = MenuItem::with_id(
        app,
        ID_APP_QUIT,
        "Quit FTPeach",
        true,
        Some("CmdOrControl+Q"),
    )?;
    app_submenu.append(&quit_item)?;

    // 2. Edit submenu (enables native clipboard & undo shortcuts in inputs)
    let edit_submenu = Submenu::new(app, "Edit", true)?;
    edit_submenu.append(&PredefinedMenuItem::undo(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::redo(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    edit_submenu.append(&PredefinedMenuItem::cut(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::copy(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::paste(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::select_all(app, None)?)?;

    // 3. Window submenu (without Close Window / ⌘W)
    let window_submenu = Submenu::new(app, "Window", true)?;
    window_submenu.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window_submenu.append(&PredefinedMenuItem::maximize(app, None)?)?;
    window_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    window_submenu.append(&PredefinedMenuItem::bring_all_to_front(app, None)?)?;

    menu.append(&app_submenu)?;
    menu.append(&edit_submenu)?;
    menu.append(&window_submenu)?;

    Ok(menu)
}

/// Installs the custom application menu and its action handler on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let menu = build_app_menu(app)?;
        app.set_menu(menu)?;
    }

    app.on_menu_event(move |app, event| match command_for(event.id().as_ref()) {
        Some(AppMenuCommand::Quit) => crate::runtime::shutdown::quit(app),
        None => {}
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::menu::MenuItemKind;

    #[test]
    fn app_menu_contains_only_ftpeach_edit_and_window_submenus() {
        let app = tauri::test::mock_app();
        let menu = build_app_menu(app.handle()).expect("menu should build");
        let items = menu.items().expect("items should read");

        assert_eq!(items.len(), 3, "must have exactly 3 top-level submenus");

        let titles: Vec<String> = items
            .iter()
            .map(|item| match item {
                MenuItemKind::Submenu(sub) => sub.text().unwrap_or_default(),
                _ => String::new(),
            })
            .collect();

        assert_eq!(titles, vec!["FTPeach", "Edit", "Window"]);
    }

    #[test]
    fn app_menu_omits_close_window_and_hide() {
        let app = tauri::test::mock_app();
        let menu = build_app_menu(app.handle()).expect("menu should build");
        let items = menu.items().expect("items should read");

        fn collect_item_texts<R: Runtime>(kind: &MenuItemKind<R>, texts: &mut Vec<String>) {
            match kind {
                MenuItemKind::Submenu(sub) => {
                    if let Ok(sub_items) = sub.items() {
                        for child in sub_items {
                            collect_item_texts(&child, texts);
                        }
                    }
                }
                MenuItemKind::MenuItem(item) => {
                    if let Ok(text) = item.text() {
                        texts.push(text);
                    }
                }
                MenuItemKind::Predefined(item) => {
                    if let Ok(text) = item.text() {
                        texts.push(text);
                    }
                }
                _ => {}
            }
        }

        let mut all_texts = Vec::new();
        for item in &items {
            collect_item_texts(item, &mut all_texts);
        }

        for text in &all_texts {
            let lower = text.to_lowercase();
            // "Hide Others" is allowed, but not "Hide" or "Hide FTPeach"
            if lower.contains("hide") {
                assert!(
                    lower.contains("hide others"),
                    "found forbidden hide item: {text}"
                );
            }
            assert!(
                !lower.contains("close window") && lower != "close",
                "found forbidden close window item: {text}"
            );
        }
    }

    #[test]
    fn app_menu_has_quit_with_dialog_route() {
        let app = tauri::test::mock_app();
        let menu = build_app_menu(app.handle()).expect("menu should build");
        let items = menu.items().expect("items should read");

        let app_submenu = match &items[0] {
            MenuItemKind::Submenu(sub) => sub,
            _ => panic!("first item must be submenu"),
        };

        let sub_items = app_submenu.items().expect("app submenu items");
        let quit_item = sub_items
            .iter()
            .find(|item| item.id().as_ref() == ID_APP_QUIT);
        assert!(quit_item.is_some(), "Quit item with ID_APP_QUIT must exist");

        // Verify routing
        assert_eq!(command_for(ID_APP_QUIT), Some(AppMenuCommand::Quit));
        assert_eq!(command_for("other-menu-id"), None);
    }
}
