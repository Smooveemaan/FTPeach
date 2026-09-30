// The application commands a global shortcut runs, and that the menu bar is
// built from the same wiring. The shortcut listener is the real one; only the
// window's key events are replaced by a function the test calls.
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useApplicationMenuCommands } from '../../../src/app/useApplicationMenuCommands.ts';
import { makePane, makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneId, PaneState } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { ShortcutOverrides } from '../../../src/shortcuts/resolve.ts';
import i18n from '../../../src/i18n/index.ts';

interface HarnessOptions {
  tabs?: number;
  modalOpen?: boolean;
  freePane?: PaneId | null;
  b?: PaneState;
  keyboardShortcuts?: ShortcutOverrides | null;
}

function harness({
  tabs: tabCount = 2,
  modalOpen = false,
  freePane = 'b',
  b = makePane('b', 'remote'),
  keyboardShortcuts = null,
}: HarnessOptions = {}) {
  const tabs = Array.from({ length: tabCount }, (_, index) => makeTab(`tab-${index}`));
  const saveNow = vi.fn();
  const h = {
    modalOpen,
    keyboardShortcuts,
    browser: {
      tabs,
      activeTabId: tabs[0]!.id,
      setActiveTabId: vi.fn(),
      openNewTab: vi.fn(),
      closeTab: vi.fn(),
      reopenClosedTab: vi.fn(),
      freeConnectTargetPaneId: freePane,
      startPaneConnect: vi.fn(),
      refreshBothPanes: vi.fn(),
      panes: { a: makePane('a', 'local'), b },
    },
    dialogs: { setShowSettings: vi.fn() },
    layout: { toggleHiddenFiles: vi.fn() },
    search: { a: vi.fn(), b: vi.fn() },
    saveSite: vi.fn((_id: PaneId) => saveNow),
    saveNow,
    openDevtools: vi.fn(),
  };
  let listener: ((_event: KeyboardEvent) => void) | null = null;
  window.api = {
    shortcuts: {
      onKeyDown: (callback: (_event: KeyboardEvent) => void) => {
        listener = callback;
        return () => {};
      },
    },
    app: { openDevtools: h.openDevtools },
  } as unknown as Window['api'];
  const { result } = renderHook(() => mount(h));
  const press = (code: string, modifiers: Partial<KeyboardEvent> = {}) => {
    const event = new KeyboardEvent('keydown', { code, cancelable: true, ...modifiers });
    listener!(event);
    return event.defaultPrevented;
  };
  return { ...h, press, menus: () => result.current };
}
type Harness = Omit<ReturnType<typeof harness>, 'press' | 'menus'>;

// The only place that knows how Application wires its commands.
function mount(h: Harness) {
  const { browser } = h;
  const menuOnly = () => {};
  return useApplicationMenuCommands({
    commands: {
      modalOpen: h.modalOpen,
      keyboardShortcuts: h.keyboardShortcuts,
      searchLocal: h.search.a,
      searchRemote: h.search.b,
      toggleHiddenFiles: h.layout.toggleHiddenFiles,
      freeConnectTargetPaneId: browser.freeConnectTargetPaneId,
      startPaneConnect: browser.startPaneConnect,
      refreshBothPanes: browser.refreshBothPanes,
      panes: browser.panes,
      handleSaveSite: h.saveSite,
      setShowSettings: h.dialogs.setShowSettings,
      openNewTab: browser.openNewTab,
      tabs: browser.tabs,
      closeTab: browser.closeTab,
      reopenClosedTab: browser.reopenClosedTab,
      activeTabId: browser.activeTabId,
      setActiveTabId: browser.setActiveTabId,
    },
    menu: {
      modalOpen: h.modalOpen,
      openNewTab: browser.openNewTab,
      tabs: browser.tabs,
      closeTab: browser.closeTab,
      reopenClosedTab: browser.reopenClosedTab,
      canReopenClosedTab: false,
      activeTabId: browser.activeTabId,
      freeConnectTargetPaneId: browser.freeConnectTargetPaneId,
      startPaneConnect: browser.startPaneConnect,
      soleConnectedRemotePane: null,
      connectedRemotePanes: [],
      disconnectPane: menuOnly,
      handleSaveSite: h.saveSite,
      setShowExportSettings: menuOnly,
      setShowImportSettings: menuOnly,
      requestQuit: menuOnly,
      theme: 'light',
      changeTheme: menuOnly,
      resetLayout: menuOnly,
      syncBrowsing: false,
      syncEligible: false,
      toggleSync: menuOnly,
      showHiddenFiles: false,
      toggleHiddenFiles: h.layout.toggleHiddenFiles,
      showLocalPane: true,
      toggleLocalPane: menuOnly,
      showRemotePane: true,
      toggleRemotePane: menuOnly,
      showTransferQueue: true,
      toggleTransferQueue: menuOnly,
      logEnabled: false,
      toggleLog: menuOnly,
      effectivePaneOrientation: 'horizontal',
      windowNarrow: false,
      togglePaneOrientation: menuOnly,
      refreshBothPanes: browser.refreshBothPanes,
      panes: browser.panes,
      canCopyBetween: () => false,
      copySelectedWithConfirm: menuOnly,
      hasCompletedTransfers: false,
      clearCompletedTransfers: menuOnly,
      refreshPane: menuOnly,
      openSiteManager: menuOnly,
      openLocalPathManager: menuOnly,
      openSettings: () => h.dialogs.setShowSettings(true),
      openAbout: menuOnly,
      checkForUpdates: menuOnly,
      keyboardShortcuts: h.keyboardShortcuts,
    },
  });
}

const ctrl = { ctrlKey: true };
const ctrlShift = { ctrlKey: true, shiftKey: true };

test('tab shortcuts open, close, reopen and cycle tabs', () => {
  const h = harness({ tabs: 3 });
  expect(h.press('KeyT', ctrl)).toBe(true);
  h.press('KeyW', ctrl);
  h.press('KeyT', ctrlShift);
  h.press('Tab', ctrl);
  h.press('Tab', ctrlShift);
  expect(h.browser.openNewTab).toHaveBeenCalledOnce();
  expect(h.browser.closeTab).toHaveBeenCalledExactlyOnceWith('tab-0');
  expect(h.browser.reopenClosedTab).toHaveBeenCalledOnce();
  expect(h.browser.setActiveTabId.mock.calls).toEqual([['tab-1'], ['tab-2']]);
});

test('the last tab is not closed and a single tab does not cycle', () => {
  const h = harness({ tabs: 1 });
  expect(h.press('KeyW', ctrl)).toBe(true);
  h.press('Tab', ctrl);
  h.press('Tab', ctrlShift);
  expect(h.browser.closeTab).not.toHaveBeenCalled();
  expect(h.browser.setActiveTabId).not.toHaveBeenCalled();
});

test('new connection starts in the free pane, and does nothing without one', () => {
  const h = harness();
  h.press('KeyN', ctrl);
  expect(h.browser.startPaneConnect).toHaveBeenCalledExactlyOnceWith('b');
  const full = harness({ freePane: null });
  full.press('KeyN', ctrl);
  expect(full.browser.startPaneConnect).not.toHaveBeenCalled();
});

test('saving a pane as a bookmark needs a local pane or a connected server', () => {
  const idle = harness();
  idle.press('KeyS', ctrl);
  idle.press('KeyS', ctrlShift);
  expect(idle.saveSite.mock.calls).toEqual([['a']]);
  expect(idle.saveNow).toHaveBeenCalledOnce();

  const connected = harness({ b: { ...makePane('b', 'remote'), status: 'connected' } });
  connected.press('KeyS', ctrlShift);
  expect(connected.saveSite.mock.calls).toEqual([['b']]);
});

test('search, hidden files, refresh and settings reach their owners', () => {
  const h = harness();
  h.press('KeyF', ctrl);
  h.press('KeyF', ctrlShift);
  h.press('KeyH', ctrl);
  h.press('F5');
  h.press('Comma', ctrl);
  expect(h.search.a).toHaveBeenCalledOnce();
  expect(h.search.b).toHaveBeenCalledOnce();
  expect(h.layout.toggleHiddenFiles).toHaveBeenCalledOnce();
  expect(h.browser.refreshBothPanes).toHaveBeenCalledOnce();
  expect(h.dialogs.setShowSettings).toHaveBeenCalledExactlyOnceWith(true);
});

test('an open dialog blocks every command but the developer tools', () => {
  const h = harness({ modalOpen: true });
  expect(h.press('KeyT', ctrl)).toBe(false);
  h.press('F5');
  expect(h.press('F12')).toBe(true);
  expect(h.browser.openNewTab).not.toHaveBeenCalled();
  expect(h.browser.refreshBothPanes).not.toHaveBeenCalled();
  expect(h.openDevtools).toHaveBeenCalledOnce();
});

test('a rebound shortcut runs its command and the menu shows the new keys', () => {
  const h = harness({ keyboardShortcuts: { 'new-tab': 'Alt+KeyN' } });
  expect(h.press('KeyT', ctrl)).toBe(false);
  h.press('KeyN', { altKey: true });
  expect(h.browser.openNewTab).toHaveBeenCalledOnce();

  const newTab = h
    .menus()
    .flatMap((menu) => menu.items)
    .find((item) => item.label === i18n.t('menu.file.newTab'));
  expect(newTab?.shortcut).toBe('Alt+N');
  newTab?.onClick?.();
  expect(h.browser.openNewTab).toHaveBeenCalledTimes(2);
});
