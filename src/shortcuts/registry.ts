export type ShortcutScope = 'global' | 'pane';
export type PaneSide = 'a' | 'b';
export interface ShortcutAction {
  id: string;
  scope: ShortcutScope;
  default: string;
  labelKey: string;
  pane?: PaneSide;
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  // Global scope (src/platform/tauriApi.ts / src/app/useAppCommands.ts)
  {
    id: 'search-local',
    scope: 'global',
    default: 'Ctrl+KeyF',
    labelKey: 'settings.shortcuts.actions.search',
    pane: 'a',
  },
  {
    id: 'search-remote',
    scope: 'global',
    default: 'Ctrl+Shift+KeyF',
    labelKey: 'settings.shortcuts.actions.search',
    pane: 'b',
  },
  {
    id: 'toggle-hidden-files',
    scope: 'global',
    default: 'Ctrl+KeyH',
    labelKey: 'settings.shortcuts.actions.toggleHiddenFiles',
  },
  {
    id: 'new-connection',
    scope: 'global',
    default: 'Ctrl+KeyN',
    labelKey: 'settings.shortcuts.actions.newConnection',
  },
  {
    id: 'save-site',
    scope: 'global',
    default: 'Ctrl+KeyS',
    labelKey: 'settings.shortcuts.actions.save',
    pane: 'a',
  },
  {
    id: 'save-site-secondary',
    scope: 'global',
    default: 'Ctrl+Shift+KeyS',
    labelKey: 'settings.shortcuts.actions.save',
    pane: 'b',
  },
  {
    id: 'open-settings',
    scope: 'global',
    default: 'Ctrl+Comma',
    labelKey: 'settings.shortcuts.actions.openSettings',
  },
  {
    id: 'new-tab',
    scope: 'global',
    default: 'Ctrl+KeyT',
    labelKey: 'settings.shortcuts.actions.newTab',
  },
  {
    id: 'close-tab',
    scope: 'global',
    default: 'Ctrl+KeyW',
    labelKey: 'settings.shortcuts.actions.closeTab',
  },
  {
    id: 'reopen-closed-tab',
    scope: 'global',
    default: 'Ctrl+Shift+KeyT',
    labelKey: 'settings.shortcuts.actions.reopenClosedTab',
  },
  {
    id: 'next-tab',
    scope: 'global',
    default: 'Ctrl+Tab',
    labelKey: 'settings.shortcuts.actions.nextTab',
  },
  {
    id: 'prev-tab',
    scope: 'global',
    default: 'Ctrl+Shift+Tab',
    labelKey: 'settings.shortcuts.actions.prevTab',
  },
  { id: 'refresh', scope: 'global', default: 'F5', labelKey: 'settings.shortcuts.actions.refresh' },

  // Pane scope (src/features/file-browser/FilePane.tsx)
  {
    id: 'select-all',
    scope: 'pane',
    default: 'Ctrl+KeyA',
    labelKey: 'settings.shortcuts.actions.selectAll',
  },
  { id: 'rename', scope: 'pane', default: 'F2', labelKey: 'filePane.rename' },
  { id: 'delete', scope: 'pane', default: 'Delete', labelKey: 'settings.shortcuts.actions.delete' },
  {
    id: 'delete-permanent',
    scope: 'pane',
    default: 'Shift+Delete',
    labelKey: 'settings.shortcuts.actions.deletePermanent',
  },
  {
    id: 'navigate-up',
    scope: 'pane',
    default: 'Backspace',
    labelKey: 'settings.shortcuts.actions.navigateUp',
  },
  {
    id: 'navigate-back',
    scope: 'pane',
    default: 'Alt+ArrowLeft',
    labelKey: 'settings.shortcuts.actions.navigateBack',
  },
  {
    id: 'navigate-forward',
    scope: 'pane',
    default: 'Alt+ArrowRight',
    labelKey: 'settings.shortcuts.actions.navigateForward',
  },
  {
    id: 'navigate-home',
    scope: 'pane',
    default: 'Alt+Home',
    labelKey: 'settings.shortcuts.actions.navigateHome',
  },
  { id: 'move-to', scope: 'pane', default: 'F6', labelKey: 'settings.shortcuts.actions.moveTo' },
  {
    id: 'new-folder',
    scope: 'pane',
    default: 'F7',
    labelKey: 'settings.shortcuts.actions.newFolder',
  },
  {
    id: 'new-file',
    scope: 'pane',
    default: 'Shift+F7',
    labelKey: 'settings.shortcuts.actions.newFile',
  },
  {
    id: 'copy-to-other-pane',
    scope: 'pane',
    default: 'F8',
    labelKey: 'settings.shortcuts.actions.copyToOtherPane',
  },
  { id: 'copy', scope: 'pane', default: 'Ctrl+KeyC', labelKey: 'settings.shortcuts.actions.copy' },
  { id: 'cut', scope: 'pane', default: 'Ctrl+KeyX', labelKey: 'settings.shortcuts.actions.cut' },
  {
    id: 'paste',
    scope: 'pane',
    default: 'Ctrl+KeyV',
    labelKey: 'settings.shortcuts.actions.paste',
  },
  {
    id: 'clear-selection',
    scope: 'pane',
    default: 'Escape',
    labelKey: 'settings.shortcuts.actions.clearSelection',
  },
  { id: 'open', scope: 'pane', default: 'Enter', labelKey: 'settings.shortcuts.actions.open' },
];

export function shortcutActionsByScope(scope: ShortcutScope): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter((action) => action.scope === scope);
}
