//! The tray icon's menu: which items a model calls for, what a click on one
//! means, and keeping the native menu in step with the model.

use super::model::{TrayAction, TrayModel};
use std::collections::HashMap;
use tauri::{
    AppHandle, Wry,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIcon,
};

pub const ID_STATUS: &str = "tray-status";
pub const ID_SHOW: &str = "tray-show";
pub const ID_PAUSE_ALL: &str = "tray-pause-all";
pub const ID_RESUME_ALL: &str = "tray-resume-all";
pub const ID_LOCK_VAULT: &str = "tray-lock-vault";
pub const ID_QUIT: &str = "tray-quit";
pub const ID_CANCEL_QUIT: &str = "tray-cancel-quit";

/// `szTip` holds 128 UTF-16 units, and `tray-icon` copies at most that many
/// without guaranteeing the terminating null, so one unit is left for it.
const TOOLTIP_UNITS: usize = 127;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemKind {
    Normal,
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemSpec {
    pub id: String,
    pub text: String,
    pub enabled: bool,
    pub kind: ItemKind,
}

impl ItemSpec {
    fn normal(id: &str, text: &str) -> Self {
        Self {
            id: id.into(),
            text: menu_text(text),
            enabled: true,
            kind: ItemKind::Normal,
        }
    }

    fn separator(index: usize) -> Self {
        Self {
            id: format!("tray-separator-{index}"),
            text: String::new(),
            enabled: true,
            kind: ItemKind::Separator,
        }
    }
}

/// What a click on a tray item asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuCommand {
    Show,
    Quit,
    Action(TrayAction),
}

/// The menu a model calls for, top to bottom. Groups are divided by a
/// separator, and an item that makes no sense right now is left out rather
/// than shown disabled; the status line is the one disabled item.
pub fn menu_spec(model: &TrayModel) -> Vec<ItemSpec> {
    let labels = &model.labels;
    let mut groups: Vec<Vec<ItemSpec>> = Vec::new();

    if !model.status.is_empty() {
        groups.push(vec![ItemSpec {
            enabled: false,
            ..ItemSpec::normal(ID_STATUS, &model.status)
        }]);
    }
    groups.push(vec![ItemSpec::normal(ID_SHOW, &labels.show)]);

    let mut transfers = Vec::new();
    // The same choice as the toolbar's shared pause button: resume-all takes
    // it over once nothing still running can be paused.
    if model.transfers.can_resume_all {
        transfers.push(ItemSpec::normal(ID_RESUME_ALL, &labels.resume_all));
    } else if model.transfers.can_pause_all {
        transfers.push(ItemSpec::normal(ID_PAUSE_ALL, &labels.pause_all));
    }
    groups.push(transfers);

    let mut vault = Vec::new();
    if model.vault_lockable {
        vault.push(ItemSpec::normal(ID_LOCK_VAULT, &labels.lock_vault));
    }
    groups.push(vault);

    // Quit stays last; while quitting waits for transfers it takes the
    // cancellation's place.
    groups.push(vec![if model.quit_pending {
        ItemSpec::normal(ID_CANCEL_QUIT, &labels.cancel_quit)
    } else {
        ItemSpec::normal(ID_QUIT, &labels.quit)
    }]);

    let mut spec = Vec::new();
    for group in groups.into_iter().filter(|group| !group.is_empty()) {
        if !spec.is_empty() {
            spec.push(ItemSpec::separator(spec.len()));
        }
        spec.extend(group);
    }
    spec
}

/// What a click on `id` means under `model`. Anything the model no longer
/// offers is `None`, so a click that raced a model change does nothing.
pub fn command_for(model: &TrayModel, id: &str) -> Option<MenuCommand> {
    let command = match id {
        ID_SHOW => MenuCommand::Show,
        ID_QUIT => MenuCommand::Quit,
        ID_PAUSE_ALL => MenuCommand::Action(TrayAction::PauseAll),
        ID_RESUME_ALL => MenuCommand::Action(TrayAction::ResumeAll),
        ID_LOCK_VAULT => MenuCommand::Action(TrayAction::LockVault),
        ID_CANCEL_QUIT => MenuCommand::Action(TrayAction::CancelQuit),
        _ => return None,
    };
    contains_id(&menu_spec(model), id).then_some(command)
}

fn contains_id(spec: &[ItemSpec], id: &str) -> bool {
    spec.iter().any(|item| item.id == id)
}

/// The icon's hover text: the status line when there is one.
pub fn tooltip(model: &TrayModel) -> String {
    let text = if model.status.is_empty() {
        "FTPeach".to_string()
    } else {
        format!("FTPeach \u{2014} {}", model.status)
    };
    truncate_utf16(&text, TOOLTIP_UNITS)
}

/// Cuts `text` to at most `max_units` UTF-16 units without splitting a
/// surrogate pair.
pub fn truncate_utf16(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = text.len();
    for (index, character) in text.char_indices() {
        if units + character.len_utf16() > max_units {
            end = index;
            break;
        }
        units += character.len_utf16();
    }
    text[..end].to_string()
}

/// Menu text is not plain text on Windows: `&` marks the access key and a
/// tab starts the accelerator column. A site or file name may carry either.
fn menu_text(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() {
                " ".to_string()
            } else if character == '&' {
                "&&".to_string()
            } else {
                character.to_string()
            }
        })
        .collect()
}

/// Two specs with the same items in the same places, whatever their text and
/// enablement: the live menu can then be edited in place.
fn same_shape(a: &[ItemSpec], b: &[ItemSpec]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| a.id == b.id && a.kind == b.kind)
}

/// The native menu behind the icon, with its items by ID.
pub struct LiveMenu {
    menu: Menu<Wry>,
    items: HashMap<String, MenuItem<Wry>>,
    spec: Vec<ItemSpec>,
    tooltip: String,
    /// The menu `set_menu` last replaced. It is kept alive until the next
    /// rebuild: the model can change while that menu is open on screen, and
    /// dropping it would destroy the native menu under the open popup.
    retired: Option<Menu<Wry>>,
}

impl LiveMenu {
    /// Builds the menu for a new icon. Runs on the main thread.
    pub fn build(app: &AppHandle, model: &TrayModel) -> tauri::Result<Self> {
        let spec = menu_spec(model);
        let (menu, items) = build_menu(app, &spec, &HashMap::new())?;
        Ok(Self {
            menu,
            items,
            spec,
            tooltip: tooltip(model),
            retired: None,
        })
    }

    pub fn menu(&self) -> &Menu<Wry> {
        &self.menu
    }

    pub fn tooltip(&self) -> &str {
        &self.tooltip
    }

    /// Brings the live menu and tooltip in line with `model`. Runs on the
    /// main thread, where the item setters take effect immediately.
    pub fn apply(
        &mut self,
        app: &AppHandle,
        tray: &TrayIcon<Wry>,
        model: &TrayModel,
    ) -> tauri::Result<()> {
        let spec = menu_spec(model);
        if same_shape(&self.spec, &spec) {
            update_changed(&self.items, &self.spec, &spec)?;
        } else {
            // Items that survive keep their native IDs, so a click on the
            // menu that is still open on screen still finds its item.
            let (menu, items) = build_menu(app, &spec, &self.items)?;
            tray.set_menu(Some(menu.clone()))?;
            self.retired = Some(std::mem::replace(&mut self.menu, menu));
            self.items = items;
        }
        self.spec = spec;

        let tooltip = tooltip(model);
        if tooltip != self.tooltip {
            tray.set_tooltip(Some(&tooltip))?;
            self.tooltip = tooltip;
        }
        Ok(())
    }
}

type Items = HashMap<String, MenuItem<Wry>>;

fn build_menu(
    app: &AppHandle,
    spec: &[ItemSpec],
    reuse: &Items,
) -> tauri::Result<(Menu<Wry>, Items)> {
    let menu = Menu::new(app)?;
    let mut items = HashMap::new();
    for item in spec {
        let native: &dyn IsMenuItem<Wry> = match item.kind {
            ItemKind::Separator => {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                continue;
            }
            ItemKind::Normal => {
                let native = match reuse.get(&item.id) {
                    Some(existing) => {
                        existing.set_text(&item.text)?;
                        existing.set_enabled(item.enabled)?;
                        existing.clone()
                    }
                    None => {
                        MenuItem::with_id(app, &item.id, &item.text, item.enabled, None::<&str>)?
                    }
                };
                items.entry(item.id.clone()).or_insert(native)
            }
        };
        menu.append(native)?;
    }
    Ok((menu, items))
}

/// Edits the items whose text or enablement differ between two specs of the
/// same shape.
fn update_changed(items: &Items, before: &[ItemSpec], after: &[ItemSpec]) -> tauri::Result<()> {
    for (old, new) in before.iter().zip(after) {
        let Some(item) = items.get(&new.id) else {
            continue;
        };
        if old.text != new.text {
            item.set_text(&new.text)?;
        }
        if old.enabled != new.enabled {
            item.set_enabled(new.enabled)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(spec: &[ItemSpec]) -> Vec<&str> {
        spec.iter().map(|item| item.id.as_str()).collect()
    }

    fn find<'a>(spec: &'a [ItemSpec], id: &str) -> &'a ItemSpec {
        spec.iter().find(|item| item.id == id).unwrap()
    }

    #[test]
    fn an_idle_model_offers_only_show_and_quit() {
        let spec = menu_spec(&TrayModel::default());
        assert_eq!(ids(&spec), [ID_SHOW, "tray-separator-1", ID_QUIT]);
        assert!(spec.iter().all(|item| item.enabled));
    }

    #[test]
    fn a_running_queue_shows_a_disabled_status_line_and_pause() {
        let mut model = TrayModel {
            status: "Transferring 3 · 42%".into(),
            ..TrayModel::default()
        };
        model.transfers.active = 3;
        model.transfers.can_pause_all = true;
        let spec = menu_spec(&model);
        assert_eq!(
            ids(&spec),
            [
                ID_STATUS,
                "tray-separator-1",
                ID_SHOW,
                "tray-separator-3",
                ID_PAUSE_ALL,
                "tray-separator-5",
                ID_QUIT
            ]
        );
        let status = find(&spec, ID_STATUS);
        assert!(!status.enabled);
        assert_eq!(status.text, "Transferring 3 · 42%");
    }

    #[test]
    fn resume_all_replaces_pause_and_neither_shows_when_impossible() {
        let mut model = TrayModel::default();
        model.transfers.can_pause_all = true;
        model.transfers.can_resume_all = true;
        let spec = menu_spec(&model);
        assert!(contains_id(&spec, ID_RESUME_ALL));
        assert!(!contains_id(&spec, ID_PAUSE_ALL));

        model.transfers.can_pause_all = false;
        model.transfers.can_resume_all = false;
        model.transfers.active = 1;
        let spec = menu_spec(&model);
        assert!(!contains_id(&spec, ID_RESUME_ALL));
        assert!(!contains_id(&spec, ID_PAUSE_ALL));
    }

    #[test]
    fn lock_vault_shows_only_while_lockable() {
        let mut model = TrayModel::default();
        assert!(!contains_id(&menu_spec(&model), ID_LOCK_VAULT));
        model.vault_lockable = true;
        let spec = menu_spec(&model);
        assert_eq!(
            ids(&spec),
            [
                ID_SHOW,
                "tray-separator-1",
                ID_LOCK_VAULT,
                "tray-separator-3",
                ID_QUIT
            ]
        );
    }

    #[test]
    fn clicks_map_to_commands_only_while_the_model_offers_them() {
        let mut model = TrayModel::default();
        assert_eq!(command_for(&model, ID_SHOW), Some(MenuCommand::Show));
        assert_eq!(command_for(&model, ID_QUIT), Some(MenuCommand::Quit));
        assert_eq!(command_for(&model, ID_PAUSE_ALL), None);
        assert_eq!(command_for(&model, ID_LOCK_VAULT), None);
        assert_eq!(command_for(&model, ID_STATUS), None);
        assert_eq!(command_for(&model, "tray-separator-1"), None);
        assert_eq!(command_for(&model, "tray-unknown"), None);

        model.transfers.can_pause_all = true;
        model.vault_lockable = true;
        assert_eq!(
            command_for(&model, ID_PAUSE_ALL),
            Some(MenuCommand::Action(TrayAction::PauseAll))
        );
        assert_eq!(
            command_for(&model, ID_LOCK_VAULT),
            Some(MenuCommand::Action(TrayAction::LockVault))
        );
        assert_eq!(command_for(&model, ID_RESUME_ALL), None);
    }

    #[test]
    fn a_pending_quit_offers_to_cancel_it_in_quit_s_place() {
        let mut model = TrayModel::default();
        assert_eq!(command_for(&model, ID_CANCEL_QUIT), None);
        model.quit_pending = true;
        let spec = menu_spec(&model);
        assert_eq!(ids(&spec), [ID_SHOW, "tray-separator-1", ID_CANCEL_QUIT]);
        assert_eq!(command_for(&model, ID_QUIT), None);
        assert_eq!(
            command_for(&model, ID_CANCEL_QUIT),
            Some(MenuCommand::Action(TrayAction::CancelQuit))
        );
    }

    #[test]
    fn tooltip_names_the_status_and_fits_the_native_buffer() {
        let mut model = TrayModel::default();
        assert_eq!(tooltip(&model), "FTPeach");
        model.status = "Transferring 3 · 42%".into();
        assert_eq!(tooltip(&model), "FTPeach \u{2014} Transferring 3 · 42%");
        model.status = "y".repeat(300);
        assert_eq!(tooltip(&model).encode_utf16().count(), TOOLTIP_UNITS);
    }

    #[test]
    fn truncation_never_splits_a_surrogate_pair() {
        assert_eq!(truncate_utf16("abc", 5), "abc");
        assert_eq!(truncate_utf16("abc", 2), "ab");
        // U+1F351 (peach) is two UTF-16 units.
        assert_eq!(truncate_utf16("a\u{1F351}", 2), "a");
        assert_eq!(truncate_utf16("a\u{1F351}", 3), "a\u{1F351}");
        assert_eq!(truncate_utf16("\u{1F351}\u{1F351}", 3), "\u{1F351}");
        assert_eq!(truncate_utf16("", 0), "");
    }

    #[test]
    fn menu_text_escapes_access_keys_and_control_characters() {
        assert_eq!(menu_text("Tom & Jerry"), "Tom && Jerry");
        assert_eq!(menu_text("a\tb\nc"), "a b c");
    }

    #[test]
    fn shape_ignores_text_and_state_but_not_items() {
        let mut model = TrayModel {
            status: "Transferring 1".into(),
            ..TrayModel::default()
        };
        let before = menu_spec(&model);
        model.status = "Transferring 2 · 10%".into();
        model.labels.show = "Afficher FTPeach".into();
        assert!(same_shape(&before, &menu_spec(&model)));

        model.vault_lockable = true;
        assert!(!same_shape(&before, &menu_spec(&model)));
    }
}
