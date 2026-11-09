import { hostPlatform } from '../platform/os.ts';

export type ShortcutScope = 'global' | 'pane';
export type PaneSide = 'a' | 'b';
export interface ShortcutAction {
  id: string;
  scope: ShortcutScope;
  default: string;
  defaultMac?: string;
  aliasesMac?: readonly string[];
  labelKey: string;
  pane?: PaneSide;
}

interface ShortcutActionDefinition {
  id: string;
  scope: ShortcutScope;
  default: string;
  defaultMac?: string;
  aliasesMac?: readonly string[];
  labelKey: string;
  pane?: PaneSide;
}

function makeAction(def: ShortcutActionDefinition): ShortcutAction {
  return {
    ...def,
    get default(): string {
      return hostPlatform() === 'macos' && def.defaultMac ? def.defaultMac : def.default;
    },
  };
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  // Global scope (src/platform/tauriApi.ts / src/app/useAppCommands.ts)
  makeAction({
    id: 'search-local',
    scope: 'global',
    default: 'Ctrl+KeyF',
    defaultMac: 'Cmd+KeyF',
    labelKey: 'settings.shortcuts.actions.search',
    pane: 'a',
  }),
  makeAction({
    id: 'search-remote',
    scope: 'global',
    default: 'Ctrl+Shift+KeyF',
    defaultMac: 'Shift+Cmd+KeyF',
    labelKey: 'settings.shortcuts.actions.search',
    pane: 'b',
  }),
  makeAction({
    id: 'toggle-hidden-files',
    scope: 'global',
    default: 'Ctrl+KeyH',
    defaultMac: 'Shift+Cmd+Period',
    labelKey: 'settings.shortcuts.actions.toggleHiddenFiles',
  }),
  makeAction({
    id: 'new-connection',
    scope: 'global',
    default: 'Ctrl+KeyN',
    defaultMac: 'Cmd+KeyK',
    labelKey: 'settings.shortcuts.actions.newConnection',
    pane: 'a',
  }),
  makeAction({
    id: 'new-connection-secondary',
    scope: 'global',
    default: 'Ctrl+Shift+KeyN',
    defaultMac: 'Shift+Cmd+KeyK',
    labelKey: 'settings.shortcuts.actions.newConnection',
    pane: 'b',
  }),
  makeAction({
    id: 'save-site',
    scope: 'global',
    default: 'Ctrl+KeyS',
    defaultMac: 'Cmd+KeyS',
    labelKey: 'settings.shortcuts.actions.save',
    pane: 'a',
  }),
  makeAction({
    id: 'save-site-secondary',
    scope: 'global',
    default: 'Ctrl+Shift+KeyS',
    defaultMac: 'Shift+Cmd+KeyS',
    labelKey: 'settings.shortcuts.actions.save',
    pane: 'b',
  }),
  makeAction({
    id: 'open-settings',
    scope: 'global',
    default: 'Ctrl+Comma',
    defaultMac: 'Cmd+Comma',
    labelKey: 'settings.shortcuts.actions.openSettings',
  }),
  makeAction({
    id: 'new-tab',
    scope: 'global',
    default: 'Ctrl+KeyT',
    defaultMac: 'Cmd+KeyT',
    labelKey: 'settings.shortcuts.actions.newTab',
  }),
  makeAction({
    id: 'close-tab',
    scope: 'global',
    default: 'Ctrl+KeyW',
    defaultMac: 'Cmd+KeyW',
    labelKey: 'settings.shortcuts.actions.closeTab',
  }),
  makeAction({
    id: 'reopen-closed-tab',
    scope: 'global',
    default: 'Ctrl+Shift+KeyT',
    defaultMac: 'Shift+Cmd+KeyT',
    labelKey: 'settings.shortcuts.actions.reopenClosedTab',
  }),
  makeAction({
    id: 'next-tab',
    scope: 'global',
    default: 'Ctrl+Tab',
    defaultMac: 'Ctrl+Tab',
    aliasesMac: ['Shift+Cmd+BracketRight'],
    labelKey: 'settings.shortcuts.actions.nextTab',
  }),
  makeAction({
    id: 'prev-tab',
    scope: 'global',
    default: 'Ctrl+Shift+Tab',
    defaultMac: 'Ctrl+Shift+Tab',
    aliasesMac: ['Shift+Cmd+BracketLeft'],
    labelKey: 'settings.shortcuts.actions.prevTab',
  }),
  makeAction({
    id: 'refresh',
    scope: 'global',
    default: 'F5',
    defaultMac: 'Cmd+KeyR',
    aliasesMac: ['F5'],
    labelKey: 'settings.shortcuts.actions.refresh',
  }),

  // Pane scope (src/features/file-browser/FilePane.tsx)
  makeAction({
    id: 'select-all',
    scope: 'pane',
    default: 'Ctrl+KeyA',
    defaultMac: 'Cmd+KeyA',
    labelKey: 'settings.shortcuts.actions.selectAll',
  }),
  makeAction({
    id: 'rename',
    scope: 'pane',
    default: 'F2',
    defaultMac: 'Enter',
    aliasesMac: ['F2'],
    labelKey: 'filePane.rename',
  }),
  makeAction({
    id: 'delete',
    scope: 'pane',
    default: 'Delete',
    defaultMac: 'Cmd+Backspace',
    labelKey: 'settings.shortcuts.actions.delete',
  }),
  makeAction({
    id: 'delete-permanent',
    scope: 'pane',
    default: 'Shift+Delete',
    defaultMac: 'Alt+Cmd+Backspace',
    labelKey: 'settings.shortcuts.actions.deletePermanent',
  }),
  makeAction({
    id: 'navigate-up',
    scope: 'pane',
    default: 'Backspace',
    defaultMac: 'Cmd+ArrowUp',
    labelKey: 'settings.shortcuts.actions.navigateUp',
  }),
  makeAction({
    id: 'navigate-back',
    scope: 'pane',
    default: 'Alt+ArrowLeft',
    defaultMac: 'Cmd+BracketLeft',
    labelKey: 'settings.shortcuts.actions.navigateBack',
  }),
  makeAction({
    id: 'navigate-forward',
    scope: 'pane',
    default: 'Alt+ArrowRight',
    defaultMac: 'Cmd+BracketRight',
    labelKey: 'settings.shortcuts.actions.navigateForward',
  }),
  makeAction({
    id: 'navigate-home',
    scope: 'pane',
    default: 'Alt+Home',
    defaultMac: 'Shift+Cmd+KeyH',
    labelKey: 'settings.shortcuts.actions.navigateHome',
  }),
  makeAction({
    id: 'move-to',
    scope: 'pane',
    default: 'F6',
    defaultMac: 'Shift+Cmd+KeyM',
    aliasesMac: ['F6'],
    labelKey: 'settings.shortcuts.actions.moveTo',
  }),
  makeAction({
    id: 'new-folder',
    scope: 'pane',
    default: 'F7',
    defaultMac: 'Shift+Cmd+KeyN',
    aliasesMac: ['F7'],
    labelKey: 'settings.shortcuts.actions.newFolder',
  }),
  makeAction({
    id: 'new-file',
    scope: 'pane',
    default: 'Shift+F7',
    defaultMac: 'Alt+Cmd+KeyN',
    aliasesMac: ['Shift+F7'],
    labelKey: 'settings.shortcuts.actions.newFile',
  }),
  makeAction({
    id: 'copy-to-other-pane',
    scope: 'pane',
    default: 'F8',
    defaultMac: 'Alt+Cmd+KeyC',
    aliasesMac: ['F8'],
    labelKey: 'settings.shortcuts.actions.copyToOtherPane',
  }),
  makeAction({
    id: 'copy',
    scope: 'pane',
    default: 'Ctrl+KeyC',
    defaultMac: 'Cmd+KeyC',
    labelKey: 'settings.shortcuts.actions.copy',
  }),
  makeAction({
    id: 'cut',
    scope: 'pane',
    default: 'Ctrl+KeyX',
    defaultMac: 'Cmd+KeyX',
    labelKey: 'settings.shortcuts.actions.cut',
  }),
  makeAction({
    id: 'paste',
    scope: 'pane',
    default: 'Ctrl+KeyV',
    defaultMac: 'Cmd+KeyV',
    labelKey: 'settings.shortcuts.actions.paste',
  }),
  makeAction({
    id: 'clear-selection',
    scope: 'pane',
    default: 'Escape',
    defaultMac: 'Escape',
    labelKey: 'settings.shortcuts.actions.clearSelection',
  }),
  makeAction({
    id: 'open',
    scope: 'pane',
    default: 'Enter',
    defaultMac: 'Cmd+ArrowDown',
    aliasesMac: ['Cmd+KeyO'],
    labelKey: 'settings.shortcuts.actions.open',
  }),
];

export function shortcutActionsByScope(scope: ShortcutScope): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter((action) => action.scope === scope);
}
