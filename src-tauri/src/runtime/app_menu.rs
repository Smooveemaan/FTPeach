//! Application menu bar (used on macOS).
//!
//! macOS applications require a system menu bar (NSMenu) at the top of the
//! screen. To prevent system shortcuts from conflicting with FTPeach's own
//! controls (e.g. ⌘W for closing tabs rather than the whole window, ⌘H for
//! home navigation), FTPeach installs a dedicated menu containing only
//! FTPeach, Edit, and Window submenus, without ⌘W ("Close Window") or ⌘H ("Hide").
//!
//! ⌘Q routes through [], prompting the user if transfers or
//! unsynced edits are in progress.

use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

pub const ID_APP_ABOUT: &str = "app-menu-about";
pub const ID_APP_QUIT: &str = "app-menu-quit";
const APP_MENU_ACTION_EVENT: &str = "app-menu:action";
pub const MAX_MENU_TEXT_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMenuCommand {
    Quit,
    About,
}

/// What an application menu item click asks for.
pub fn command_for(id: &str) -> Option<AppMenuCommand> {
    if id == ID_APP_QUIT {
        Some(AppMenuCommand::Quit)
    } else if id == ID_APP_ABOUT {
        Some(AppMenuCommand::About)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppMenuItemPayload {
    pub id: Option<String>,
    pub label: Option<String>,
    pub separator: Option<bool>,
    pub disabled: Option<bool>,
    pub checked: Option<bool>,
    pub shortcut: Option<String>,
    pub children: Option<Vec<AppMenuItemPayload>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppMenuTopEntry {
    pub id: Option<String>,
    pub label: String,
    pub items: Vec<AppMenuItemPayload>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppMenuModel {
    pub menus: Vec<AppMenuTopEntry>,
}

impl AppMenuModel {
    pub fn validate(&self) -> Result<(), String> {
        for menu in &self.menus {
            if menu.label.chars().count() > MAX_MENU_TEXT_CHARS {
                return Err(format!(
                    "Menu label is longer than {MAX_MENU_TEXT_CHARS} chars"
                ));
            }
            Self::validate_items(&menu.items)?;
        }
        Ok(())
    }

    fn validate_items(items: &[AppMenuItemPayload]) -> Result<(), String> {
        for item in items {
            if let Some(label) = &item.label
                && label.chars().count() > MAX_MENU_TEXT_CHARS
            {
                return Err(format!(
                    "Menu item label is longer than {MAX_MENU_TEXT_CHARS} chars"
                ));
            }
            if let Some(id) = &item.id
                && id.chars().count() > MAX_MENU_TEXT_CHARS
            {
                return Err(format!(
                    "Menu item id is longer than {MAX_MENU_TEXT_CHARS} chars"
                ));
            }
            if let Some(children) = &item.children {
                Self::validate_items(children)?;
            }
        }
        Ok(())
    }
}

pub struct AppMenuState {
    inner: Mutex<AppMenuInner>,
}

struct AppMenuInner {
    model: Option<AppMenuModel>,
    generation: u64,
}

impl AppMenuState {
    fn lock(&self) -> MutexGuard<'_, AppMenuInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Builds the custom application menu:
/// - FTPeach (About FTPeach, Services, Hide Others, Show All, Quit with dialog)
/// - Top-level menus provided by the renderer (File, Edit, View, Transfer, Bookmarks, Help)
/// - Window (Minimize, Zoom, Bring All to Front)
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build_app_menu<R: Runtime>(
    app: &AppHandle<R>,
    dynamic: Option<&AppMenuModel>,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    // 1. FTPeach submenu
    let app_submenu = Submenu::new(app, "FTPeach", true)?;
    let about_item = MenuItem::with_id(app, ID_APP_ABOUT, "About FTPeach", true, None::<&str>)?;
    app_submenu.append(&about_item)?;
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
    menu.append(&app_submenu)?;

    if let Some(model) = dynamic {
        let mut had_edit = false;
        for top in &model.menus {
            if top.id.as_deref() == Some("edit") || top.label == "Edit" {
                had_edit = true;
                let edit_submenu = Submenu::new(app, &top.label, true)?;
                // Prepend standard editing actions for WebView inputs
                edit_submenu.append(&PredefinedMenuItem::undo(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::redo(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::separator(app)?)?;
                edit_submenu.append(&PredefinedMenuItem::cut(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::copy(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::paste(app, None)?)?;
                edit_submenu.append(&PredefinedMenuItem::select_all(app, None)?)?;
                if !top.items.is_empty() {
                    edit_submenu.append(&PredefinedMenuItem::separator(app)?)?;
                    for item in &top.items {
                        append_dynamic_item(app, &edit_submenu, item)?;
                    }
                }
                menu.append(&edit_submenu)?;
            } else {
                let submenu = Submenu::new(app, &top.label, true)?;
                for item in &top.items {
                    append_dynamic_item(app, &submenu, item)?;
                }
                menu.append(&submenu)?;
            }
        }
        if !had_edit {
            let edit_submenu = build_default_edit_submenu(app)?;
            menu.append(&edit_submenu)?;
        }
    } else {
        // Fallback default Edit submenu
        let edit_submenu = build_default_edit_submenu(app)?;
        menu.append(&edit_submenu)?;
    }

    // Window submenu (without Close Window / ⌘W)
    let window_submenu = Submenu::new(app, "Window", true)?;
    window_submenu.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window_submenu.append(&PredefinedMenuItem::maximize(app, None)?)?;
    window_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    window_submenu.append(&PredefinedMenuItem::bring_all_to_front(app, None)?)?;
    menu.append(&window_submenu)?;

    Ok(menu)
}

fn build_default_edit_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let edit_submenu = Submenu::new(app, "Edit", true)?;
    edit_submenu.append(&PredefinedMenuItem::undo(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::redo(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::separator(app)?)?;
    edit_submenu.append(&PredefinedMenuItem::cut(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::copy(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::paste(app, None)?)?;
    edit_submenu.append(&PredefinedMenuItem::select_all(app, None)?)?;
    Ok(edit_submenu)
}

fn append_dynamic_item<R: Runtime>(
    app: &AppHandle<R>,
    parent: &Submenu<R>,
    item: &AppMenuItemPayload,
) -> tauri::Result<()> {
    if item.separator == Some(true) {
        parent.append(&PredefinedMenuItem::separator(app)?)?;
        return Ok(());
    }

    let text = item.label.as_deref().unwrap_or("");
    let enabled = !item.disabled.unwrap_or(false);

    if let Some(children) = &item.children
        && !children.is_empty()
    {
        let sub = if let Some(id) = &item.id {
            Submenu::with_id(app, id, text, enabled)?
        } else {
            Submenu::new(app, text, enabled)?
        };
        for child in children {
            append_dynamic_item(app, &sub, child)?;
        }
        parent.append(&sub)?;
        return Ok(());
    }

    let id = item.id.clone().unwrap_or_default();
    let accelerator = item.shortcut.as_deref();

    if let Some(checked) = item.checked {
        let check_item = match CheckMenuItem::with_id(app, &id, text, enabled, checked, accelerator)
        {
            Ok(item) => item,
            Err(_) => CheckMenuItem::with_id(app, &id, text, enabled, checked, None::<&str>)?,
        };
        parent.append(&check_item)?;
    } else {
        let menu_item = match MenuItem::with_id(app, &id, text, enabled, accelerator) {
            Ok(item) => item,
            Err(_) => MenuItem::with_id(app, &id, text, enabled, None::<&str>)?,
        };
        parent.append(&menu_item)?;
    }

    Ok(())
}

/// Applies a new menu model from the renderer. Runs on the main thread.
pub fn set_model(app: &AppHandle, model: AppMenuModel) {
    let state = app.state::<AppMenuState>();
    {
        let mut inner = state.lock();
        inner.model = Some(model.clone());
        inner.generation += 1;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        match build_app_menu(&handle, Some(&model)) {
            Ok(menu) => {
                let _ = handle.set_menu(menu);
            }
            Err(e) => {
                log::warn!("could not rebuild application menu: {e}");
            }
        }
    });
}

/// Installs the custom application menu and its action handler on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    app.manage(AppMenuState {
        inner: Mutex::new(AppMenuInner {
            model: None,
            generation: 0,
        }),
    });

    #[cfg(target_os = "macos")]
    {
        let menu = build_app_menu(app, None)?;
        app.set_menu(menu)?;
    }

    app.on_menu_event(move |app, event| {
        let id = event.id().as_ref();
        match command_for(id) {
            Some(AppMenuCommand::Quit) => crate::runtime::shutdown::quit(app),
            Some(AppMenuCommand::About) => {
                if let Err(error) = app.emit_to("main", APP_MENU_ACTION_EVENT, "about") {
                    log::warn!("could not emit app menu action: {error}");
                }
            }
            None => {
                if id.starts_with("app-menu:") {
                    let action_id = id.strip_prefix("app-menu:").unwrap_or(id);
                    if let Err(error) = app.emit_to("main", APP_MENU_ACTION_EVENT, action_id) {
                        log::warn!("could not emit app menu action: {error}");
                    }
                }
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_routing_recognizes_quit() {
        assert_eq!(command_for(ID_APP_QUIT), Some(AppMenuCommand::Quit));
        assert_eq!(command_for(ID_APP_ABOUT), Some(AppMenuCommand::About));
        assert_eq!(command_for("other-id"), None);
    }

    #[test]
    fn model_validation_enforces_bounds() {
        let mut model = AppMenuModel {
            menus: vec![AppMenuTopEntry {
                id: Some("file".into()),
                label: "File".into(),
                items: vec![AppMenuItemPayload {
                    id: Some("app-menu:new-tab".into()),
                    label: Some("New Tab".into()),
                    separator: None,
                    disabled: Some(false),
                    checked: None,
                    shortcut: Some("Cmd+T".into()),
                    children: None,
                }],
            }],
        };
        assert_eq!(model.validate(), Ok(()));

        model.menus[0].label = "x".repeat(MAX_MENU_TEXT_CHARS + 1);
        assert!(model.validate().is_err());
    }
}
