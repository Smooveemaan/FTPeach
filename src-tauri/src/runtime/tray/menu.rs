//! The tray icon's menu: which items a model calls for, what a click on one
//! means, and keeping the native menu in step with the model.

use super::model::{TrayAction, TrayModel};
use std::collections::HashMap;
use tauri::{
    AppHandle, Wry,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIcon,
};

pub const ID_STATUS: &str = "tray-status";
pub const ID_SHOW: &str = "tray-show";
pub const ID_PAUSE_ALL: &str = "tray-pause-all";
pub const ID_RESUME_ALL: &str = "tray-resume-all";
pub const ID_SPEED: &str = "tray-speed";
pub const ID_PREVENT_SLEEP: &str = "tray-prevent-sleep";
pub const ID_NOTIFY: &str = "tray-notify";
pub const ID_RECENT: &str = "tray-recent";
pub const ID_LOCK_VAULT: &str = "tray-lock-vault";
pub const ID_QUIT: &str = "tray-quit";
pub const ID_CANCEL_QUIT: &str = "tray-cancel-quit";
/// Followed by the preset's index in the model.
const SPEED_PREFIX: &str = "tray-speed-";
/// Followed by the site's index in the model.
const RECENT_PREFIX: &str = "tray-recent-";

/// `szTip` holds 128 UTF-16 units, and `tray-icon` copies at most that many
/// without guaranteeing the terminating null, so one unit is left for it.
const TOOLTIP_UNITS: usize = 127;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemKind {
    Normal,
    Check(bool),
    Submenu(Vec<ItemSpec>),
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
    fn normal(id: impl Into<String>, text: &str) -> Self {
        Self {
            id: id.into(),
            text: menu_text(text),
            enabled: true,
            kind: ItemKind::Normal,
        }
    }

    fn check(id: impl Into<String>, text: &str, checked: bool) -> Self {
        Self {
            kind: ItemKind::Check(checked),
            ..Self::normal(id, text)
        }
    }

    fn submenu(id: &str, text: &str, children: Vec<ItemSpec>) -> Self {
        Self {
            kind: ItemKind::Submenu(children),
            ..Self::normal(id, text)
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
    // The renderer always sends the presets. The model in use before it has
    // spoken has none, and offers no settings nothing could apply.
    if !model.speed_presets.is_empty() {
        let presets = model
            .speed_presets
            .iter()
            .enumerate()
            .map(|(index, preset)| {
                ItemSpec::check(
                    format!("{SPEED_PREFIX}{index}"),
                    &preset.label,
                    preset.kbps == model.speed_limit_kbps,
                )
            })
            .collect();
        transfers.push(ItemSpec::submenu(ID_SPEED, &labels.speed_limit, presets));
        transfers.push(ItemSpec::check(
            ID_PREVENT_SLEEP,
            &labels.prevent_sleep,
            model.prevent_sleep,
        ));
        transfers.push(ItemSpec::check(
            ID_NOTIFY,
            &labels.notify,
            model.notify_on_complete,
        ));
    }
    groups.push(transfers);

    let mut connections = Vec::new();
    if !model.recent_sites.is_empty() {
        let sites = model
            .recent_sites
            .iter()
            .enumerate()
            .map(|(index, site)| ItemSpec::normal(format!("{RECENT_PREFIX}{index}"), &site.label))
            .collect();
        connections.push(ItemSpec::submenu(
            ID_RECENT,
            &labels.recent_connections,
            sites,
        ));
    }
    if model.vault_lockable {
        connections.push(ItemSpec::normal(ID_LOCK_VAULT, &labels.lock_vault));
    }
    groups.push(connections);

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
/// offers is `None`, so a click that raced a model change does nothing. The
/// speed and the site come from the model, never from the item's text.
pub fn command_for(model: &TrayModel, id: &str) -> Option<MenuCommand> {
    if !contains_id(&menu_spec(model), id) {
        return None;
    }
    let action = match id {
        ID_SHOW => return Some(MenuCommand::Show),
        ID_QUIT => return Some(MenuCommand::Quit),
        ID_PAUSE_ALL => TrayAction::PauseAll,
        ID_RESUME_ALL => TrayAction::ResumeAll,
        ID_LOCK_VAULT => TrayAction::LockVault,
        ID_CANCEL_QUIT => TrayAction::CancelQuit,
        ID_PREVENT_SLEEP => TrayAction::SetPreventSleep {
            enabled: !model.prevent_sleep,
        },
        ID_NOTIFY => TrayAction::SetNotifyOnComplete {
            enabled: !model.notify_on_complete,
        },
        _ => {
            if let Some(preset) =
                index_after(id, SPEED_PREFIX).and_then(|index| model.speed_presets.get(index))
            {
                TrayAction::SetSpeedLimit { kbps: preset.kbps }
            } else if let Some(site) =
                index_after(id, RECENT_PREFIX).and_then(|index| model.recent_sites.get(index))
            {
                TrayAction::Connect {
                    site_id: site.id.clone(),
                }
            } else {
                return None;
            }
        }
    };
    Some(MenuCommand::Action(action))
}

fn index_after(id: &str, prefix: &str) -> Option<usize> {
    id.strip_prefix(prefix)?.parse().ok()
}

fn contains_id(spec: &[ItemSpec], id: &str) -> bool {
    spec.iter().any(|item| {
        item.id == id
            || matches!(&item.kind, ItemKind::Submenu(children) if contains_id(children, id))
    })
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

/// Two specs with the same items in the same places, whatever their text,
/// checks and enablement: the live menu can then be edited in place.
fn same_shape(a: &[ItemSpec], b: &[ItemSpec]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            a.id == b.id
                && match (&a.kind, &b.kind) {
                    (ItemKind::Submenu(a), ItemKind::Submenu(b)) => same_shape(a, b),
                    (ItemKind::Check(_), ItemKind::Check(_))
                    | (ItemKind::Normal, ItemKind::Normal)
                    | (ItemKind::Separator, ItemKind::Separator) => true,
                    _ => false,
                }
        })
}

enum LiveItem {
    Normal(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
    Submenu(Submenu<Wry>),
}

type Items = HashMap<String, LiveItem>;

/// The native menu behind the icon, with its items by ID.
pub struct LiveMenu {
    menu: Menu<Wry>,
    items: Items,
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

    /// Puts every check item back the way the model has it. Windows flips a
    /// check item as it is clicked, before the click is handled; the setting
    /// changes only once the renderer applies it and sends its next model.
    pub fn resync_checks(&self) -> tauri::Result<()> {
        resync_checks(&self.items, &self.spec)
    }
}

fn build_menu(
    app: &AppHandle,
    spec: &[ItemSpec],
    reuse: &Items,
) -> tauri::Result<(Menu<Wry>, Items)> {
    let menu = Menu::new(app)?;
    let mut items = HashMap::new();
    for item in spec {
        append(app, item, reuse, &mut items, &|native| menu.append(native))?;
    }
    Ok((menu, items))
}

type AddItem<'a> = &'a dyn Fn(&dyn IsMenuItem<Wry>) -> tauri::Result<()>;

fn append(
    app: &AppHandle,
    spec: &ItemSpec,
    reuse: &Items,
    items: &mut Items,
    add: AddItem<'_>,
) -> tauri::Result<()> {
    let live = match (&spec.kind, reuse.get(&spec.id)) {
        (ItemKind::Separator, _) => return add(&PredefinedMenuItem::separator(app)?),
        (ItemKind::Normal, Some(LiveItem::Normal(item))) => {
            item.set_text(&spec.text)?;
            item.set_enabled(spec.enabled)?;
            LiveItem::Normal(item.clone())
        }
        (ItemKind::Normal, _) => LiveItem::Normal(MenuItem::with_id(
            app,
            &spec.id,
            &spec.text,
            spec.enabled,
            None::<&str>,
        )?),
        (ItemKind::Check(checked), Some(LiveItem::Check(item))) => {
            item.set_text(&spec.text)?;
            item.set_enabled(spec.enabled)?;
            item.set_checked(*checked)?;
            LiveItem::Check(item.clone())
        }
        (ItemKind::Check(checked), _) => LiveItem::Check(CheckMenuItem::with_id(
            app,
            &spec.id,
            &spec.text,
            spec.enabled,
            *checked,
            None::<&str>,
        )?),
        // A submenu is always new, since its children may differ; the
        // children themselves are reused like any other item.
        (ItemKind::Submenu(children), _) => {
            let submenu = Submenu::with_id(app, &spec.id, &spec.text, spec.enabled)?;
            for child in children {
                append(app, child, reuse, items, &|native| submenu.append(native))?;
            }
            LiveItem::Submenu(submenu)
        }
    };
    match &live {
        LiveItem::Normal(item) => add(item)?,
        LiveItem::Check(item) => add(item)?,
        LiveItem::Submenu(item) => add(item)?,
    }
    items.insert(spec.id.clone(), live);
    Ok(())
}

/// Edits the items whose text, check or enablement differ between two specs
/// of the same shape.
fn update_changed(items: &Items, before: &[ItemSpec], after: &[ItemSpec]) -> tauri::Result<()> {
    for (old, new) in before.iter().zip(after) {
        if let (ItemKind::Submenu(old_children), ItemKind::Submenu(new_children)) =
            (&old.kind, &new.kind)
        {
            update_changed(items, old_children, new_children)?;
        }
        let Some(item) = items.get(&new.id) else {
            continue;
        };
        let text = (old.text != new.text).then_some(new.text.as_str());
        let enabled = (old.enabled != new.enabled).then_some(new.enabled);
        match item {
            LiveItem::Normal(item) => {
                if let Some(text) = text {
                    item.set_text(text)?;
                }
                if let Some(enabled) = enabled {
                    item.set_enabled(enabled)?;
                }
            }
            LiveItem::Check(item) => {
                if let Some(text) = text {
                    item.set_text(text)?;
                }
                if let Some(enabled) = enabled {
                    item.set_enabled(enabled)?;
                }
                if let ItemKind::Check(checked) = new.kind
                    && old.kind != new.kind
                {
                    item.set_checked(checked)?;
                }
            }
            LiveItem::Submenu(item) => {
                if let Some(text) = text {
                    item.set_text(text)?;
                }
                if let Some(enabled) = enabled {
                    item.set_enabled(enabled)?;
                }
            }
        }
    }
    Ok(())
}

fn resync_checks(items: &Items, spec: &[ItemSpec]) -> tauri::Result<()> {
    for item in spec {
        match &item.kind {
            ItemKind::Check(checked) => {
                if let Some(LiveItem::Check(native)) = items.get(&item.id) {
                    native.set_checked(*checked)?;
                }
            }
            ItemKind::Submenu(children) => resync_checks(items, children)?,
            ItemKind::Normal | ItemKind::Separator => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::model::{RecentSite, SpeedPreset};
    use super::*;

    fn ids(spec: &[ItemSpec]) -> Vec<&str> {
        spec.iter().map(|item| item.id.as_str()).collect()
    }

    fn find<'a>(spec: &'a [ItemSpec], id: &str) -> &'a ItemSpec {
        spec.iter().find(|item| item.id == id).unwrap()
    }

    fn children<'a>(spec: &'a [ItemSpec], id: &str) -> &'a [ItemSpec] {
        match &find(spec, id).kind {
            ItemKind::Submenu(children) => children,
            kind => panic!("{id} is not a submenu: {kind:?}"),
        }
    }

    fn preset(kbps: u64, label: &str) -> SpeedPreset {
        SpeedPreset {
            kbps,
            label: label.into(),
        }
    }

    fn site(id: &str, label: &str) -> RecentSite {
        RecentSite {
            id: id.into(),
            label: label.into(),
        }
    }

    /// A model as the renderer sends it, with the quick settings in place.
    fn configured() -> TrayModel {
        TrayModel {
            speed_limit_kbps: 512,
            speed_presets: vec![
                preset(0, "No limit"),
                preset(512, "512 KB/s"),
                preset(1024, "1 MB/s"),
            ],
            prevent_sleep: true,
            notify_on_complete: false,
            ..TrayModel::default()
        }
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
    fn quick_settings_show_their_current_values() {
        let spec = menu_spec(&configured());
        assert_eq!(
            ids(&spec),
            [
                ID_SHOW,
                "tray-separator-1",
                ID_SPEED,
                ID_PREVENT_SLEEP,
                ID_NOTIFY,
                "tray-separator-5",
                ID_QUIT
            ]
        );
        let speeds = children(&spec, ID_SPEED);
        assert_eq!(
            ids(speeds),
            ["tray-speed-0", "tray-speed-1", "tray-speed-2"]
        );
        assert_eq!(
            speeds
                .iter()
                .map(|item| item.kind.clone())
                .collect::<Vec<_>>(),
            [
                ItemKind::Check(false),
                ItemKind::Check(true),
                ItemKind::Check(false)
            ]
        );
        assert_eq!(find(&spec, ID_PREVENT_SLEEP).kind, ItemKind::Check(true));
        assert_eq!(find(&spec, ID_NOTIFY).kind, ItemKind::Check(false));
    }

    #[test]
    fn quick_settings_ask_for_the_opposite_or_the_preset_clicked() {
        let model = configured();
        assert_eq!(
            command_for(&model, ID_PREVENT_SLEEP),
            Some(MenuCommand::Action(TrayAction::SetPreventSleep {
                enabled: false
            }))
        );
        assert_eq!(
            command_for(&model, ID_NOTIFY),
            Some(MenuCommand::Action(TrayAction::SetNotifyOnComplete {
                enabled: true
            }))
        );
        assert_eq!(
            command_for(&model, "tray-speed-2"),
            Some(MenuCommand::Action(TrayAction::SetSpeedLimit {
                kbps: 1024
            }))
        );
        assert_eq!(command_for(&model, "tray-speed-3"), None);
        assert_eq!(command_for(&model, "tray-speed-01"), None);
        assert_eq!(command_for(&model, ID_SPEED), None);
        assert_eq!(command_for(&TrayModel::default(), ID_NOTIFY), None);
    }

    #[test]
    fn recent_connections_list_the_model_s_sites_by_index() {
        let mut model = configured();
        assert!(!contains_id(&menu_spec(&model), ID_RECENT));
        model.recent_sites = vec![site("a", "Tom & Jerry"), site("b", "Staging")];
        model.vault_lockable = true;
        let spec = menu_spec(&model);
        assert_eq!(
            ids(&spec)[5..],
            [
                "tray-separator-5",
                ID_RECENT,
                ID_LOCK_VAULT,
                "tray-separator-8",
                ID_QUIT
            ]
        );
        let sites = children(&spec, ID_RECENT);
        assert_eq!(ids(sites), ["tray-recent-0", "tray-recent-1"]);
        assert_eq!(sites[0].text, "Tom && Jerry");
        assert_eq!(
            command_for(&model, "tray-recent-1"),
            Some(MenuCommand::Action(TrayAction::Connect {
                site_id: "b".into()
            }))
        );
        assert_eq!(command_for(&model, "tray-recent-2"), None);
        assert_eq!(command_for(&model, ID_RECENT), None);
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
            ..configured()
        };
        let before = menu_spec(&model);
        model.status = "Transferring 2 · 10%".into();
        model.labels.show = "Afficher FTPeach".into();
        model.speed_limit_kbps = 1024;
        model.prevent_sleep = false;
        assert!(same_shape(&before, &menu_spec(&model)));

        model.vault_lockable = true;
        assert!(!same_shape(&before, &menu_spec(&model)));

        let mut sites = configured();
        sites.recent_sites = vec![site("a", "A")];
        let one = menu_spec(&sites);
        sites.recent_sites.push(site("b", "B"));
        assert!(!same_shape(&one, &menu_spec(&sites)));
    }
}
