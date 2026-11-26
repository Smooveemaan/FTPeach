// The application commands a global shortcut runs, and that the menu bar is
// built from the same wiring. The shortcut listener is the real one; only the
// window's key events are replaced by a function the test calls.
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useApplicationMenuCommands } from '../../../src/app/useApplicationMenuCommands.ts';
import { makePane, makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneId, PaneState } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { FileSearchHandle } from '../../../src/features/file-browser/index.ts';
import i18n from '../../../src/i18n/index.ts';
import {
  WHEEL_GESTURE_IDLE_MS,
  consumeWheelZoomEvent,
  createWheelZoomState,
} from '../../../src/shared/contentZoom.ts';

interface HarnessOptions {
  tabs?: number;
  modalOpen?: boolean;
  freePane?: PaneId | null;
  b?: PaneState;
  keyboardShortcuts?: Record<string, string> | null;
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
    dialogs: { setShowSettings: vi.fn(), requestConfirm: vi.fn() },
    layout: { toggleHiddenFiles: vi.fn() },
    search: { a: vi.fn(), b: vi.fn() },
    saveSite: vi.fn((_id: PaneId) => saveNow),
    saveNow,
    setFileListScale: vi.fn(),
    setTerminalFontSize: vi.fn(),
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
  const menuOnly = () => {};
  return useApplicationMenuCommands({
    modalOpen: h.modalOpen,
    settings: {
      interface: { theme: 'light' },
      layout: {
        showHiddenFiles: false,
        showLocalPane: true,
        showRemotePane: true,
        showTransferQueue: true,
      },
      logging: { logEnabled: false },
      shortcuts: { keyboardShortcuts: h.keyboardShortcuts ?? {} },
    },
    browser: {
      ...h.browser,
      canReopenClosedTab: false,
      connectedRemotePanes: [],
      disconnectPane: async () => {},
      syncBrowsing: false,
      syncEligible: false,
      toggleSync: menuOnly,
      canCopyBetween: () => false,
      refreshPane: async () => {},
    },
    clipboard: { copySelectedWithConfirm: async () => {} },
    workspace: {
      toggleLocalPane: menuOnly,
      toggleRemotePane: menuOnly,
      toggleTransferQueue: menuOnly,
      toggleHiddenFiles: h.layout.toggleHiddenFiles,
      toggleLog: menuOnly,
      togglePaneOrientation: menuOnly,
      effectivePaneOrientation: 'horizontal',
      windowNarrow: false,
    },
    dialogs: {
      setShowSettings: h.dialogs.setShowSettings,
      setShowAbout: menuOnly,
      setShowSiteManagerDialog: menuOnly,
      setShowLocalPathManagerDialog: menuOnly,
      setShowExportSettings: menuOnly,
      requestConfirm: h.dialogs.requestConfirm,
      setShowImportSettings: menuOnly,
    },
    transfers: { hasCompletedTransfers: false, clearCompletedTransfers: menuOnly },
    applicationSettings: {
      changeTheme: menuOnly,
      setFileListScale: h.setFileListScale,
      setTerminalFontSize: h.setTerminalFontSize,
    },
    searchInputRefs: {
      a: { current: { toggle: h.search.a } as unknown as FileSearchHandle },
      b: { current: { toggle: h.search.b } as unknown as FileSearchHandle },
    },
    saveSite: h.saveSite,
    quit: { request: menuOnly },
    resetLayout: menuOnly,
    checkForUpdates: menuOnly,
  });
}

const ctrl = { ctrlKey: true };
const ctrlShift = { ctrlKey: true, shiftKey: true };
const cmd = { metaKey: true };

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

test('Ctrl+N starts a connection on the left, Ctrl+Shift+N on the right, asking before replacing one', () => {
  const h = harness();
  h.press('KeyN', ctrl);
  h.press('KeyN', ctrlShift);
  expect(h.browser.startPaneConnect.mock.calls).toEqual([['a'], ['b']]);
  expect(h.dialogs.requestConfirm).not.toHaveBeenCalled();

  const connected = harness({ b: { ...makePane('b', 'remote'), status: 'connected' } });
  connected.press('KeyN', ctrlShift);
  expect(connected.browser.startPaneConnect).not.toHaveBeenCalled();
  vi.mocked(connected.dialogs.requestConfirm).mock.calls[0]![1]();
  expect(connected.browser.startPaneConnect).toHaveBeenCalledExactlyOnceWith('b');
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

test('Cmd+R, Cmd+P and Cmd+F prevent default browser actions without touching the page', () => {
  const h = harness();
  expect(h.press('KeyP', cmd)).toBe(true);
  expect(h.press('KeyR', cmd)).toBe(true);
  expect(h.press('KeyF', cmd)).toBe(true);
  expect(h.search.a).toHaveBeenCalledOnce();

  // Even when a modal is open, browser print, reload and in-page find stay suppressed
  const modalHarness = harness({ modalOpen: true });
  expect(modalHarness.press('KeyP', cmd)).toBe(true);
  expect(modalHarness.press('KeyR', cmd)).toBe(true);
  expect(modalHarness.press('KeyF', cmd)).toBe(true);
  expect(modalHarness.search.a).not.toHaveBeenCalled();
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

test('zoom shortcuts and Ctrl+Wheel target file list or terminal based on focus and hover', () => {
  const h = harness();
  expect(h.press('Equal', ctrl)).toBe(true);
  expect(h.press('Minus', ctrl)).toBe(true);
  expect(h.press('Digit0', ctrl)).toBe(true);
  expect(h.setFileListScale).toHaveBeenCalledTimes(3);
  expect(h.setTerminalFontSize).not.toHaveBeenCalled();

  const paneList = document.createElement('div');
  paneList.className = 'pane-list';
  const terminalPanel = document.createElement('div');
  terminalPanel.className = 'terminal-panel';
  const terminalBody = document.createElement('div');
  terminalBody.setAttribute('data-terminal-input', 'true');
  terminalBody.tabIndex = 0;
  terminalPanel.appendChild(terminalBody);
  document.body.append(paneList, terminalPanel);

  try {
    const paneWheel = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    paneList.dispatchEvent(paneWheel);
    expect(paneWheel.defaultPrevented).toBe(true);
    expect(h.setFileListScale).toHaveBeenCalledTimes(4);

    const termWheel = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    terminalBody.dispatchEvent(termWheel);
    expect(termWheel.defaultPrevented).toBe(true);
    expect(h.setTerminalFontSize).toHaveBeenCalledTimes(1);

    // Focusing inside the terminal routes keyboard and View-menu zoom to terminal font size.
    terminalBody.focus();
    expect(h.press('Equal', ctrl)).toBe(true);
    expect(h.setTerminalFontSize).toHaveBeenCalledTimes(2);
    const viewZoomIn = h
      .menus()
      .flatMap((menu) => menu.items)
      .find((item) => item.id === 'zoom-in');
    expect(viewZoomIn?.shortcut).toBe('Ctrl++');
    viewZoomIn?.onClick?.();
    expect(h.setTerminalFontSize).toHaveBeenCalledTimes(3);
  } finally {
    paneList.remove();
    terminalPanel.remove();
  }
});

test('momentum scroll followed by pressing the zoom modifier does not zoom, even when a child stops propagation', () => {
  const h = harness();
  const paneList = document.createElement('div');
  paneList.className = 'pane-list';
  const terminalPanel = document.createElement('div');
  terminalPanel.className = 'terminal-panel';
  const terminalBody = document.createElement('div');
  // Mimic @xterm/xterm stopping wheel propagation while scrolling the terminal.
  terminalBody.addEventListener('wheel', (event) => {
    event.stopPropagation();
  });
  terminalPanel.appendChild(terminalBody);
  document.body.append(paneList, terminalPanel);

  try {
    // Plain scroll inside terminal (child calls stopPropagation), followed immediately by
    // momentum wheel events after pressing the zoom modifier.
    terminalBody.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 20, bubbles: true, cancelable: true }),
    );
    const momentumInTerminal = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: 60,
      bubbles: true,
      cancelable: true,
    });
    terminalBody.dispatchEvent(momentumInTerminal);
    expect(h.setTerminalFontSize).not.toHaveBeenCalled();

    // Same inside a file pane: momentum events arriving after modifier press do not scale rows.
    paneList.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 16, bubbles: true, cancelable: true }),
    );
    const momentumInPane = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: 60,
      bubbles: true,
      cancelable: true,
    });
    paneList.dispatchEvent(momentumInPane);
    expect(h.setFileListScale).not.toHaveBeenCalled();
  } finally {
    paneList.remove();
    terminalPanel.remove();
  }
});

test('consumeWheelZoomEvent ignores modifier changes during momentum and accumulates small trackpad deltas', () => {
  const state = createWheelZoomState();

  // Active scroll stream lasting >1s with macOS-like momentum ticks every ~50ms.
  for (let t = 0; t <= 1000; t += 50) {
    expect(
      consumeWheelZoomEvent(state, { timeStamp: t, zoomModifier: false, deltaY: 12, deltaMode: 0 }),
    ).toEqual({ zoomGesture: false, direction: null });
  }

  // Pressing Cmd at 1050ms while momentum keeps firing stays locked to scroll mode.
  for (let t = 1050; t <= 1500; t += 100) {
    expect(
      consumeWheelZoomEvent(state, { timeStamp: t, zoomModifier: true, deltaY: 50, deltaMode: 0 }),
    ).toEqual({ zoomGesture: false, direction: null });
  }

  // Once the wheel stream has been idle longer than WHEEL_GESTURE_IDLE_MS, deliberate
  // modifier + small trackpad ticks accumulate until the threshold instead of stepping on 1px.
  const resumeAt = 1500 + WHEEL_GESTURE_IDLE_MS + 1;
  expect(
    consumeWheelZoomEvent(state, {
      timeStamp: resumeAt,
      zoomModifier: true,
      deltaY: -15,
      deltaMode: 0,
    }),
  ).toEqual({ zoomGesture: true, direction: null });
  expect(
    consumeWheelZoomEvent(state, {
      timeStamp: resumeAt + 20,
      zoomModifier: true,
      deltaY: -15,
      deltaMode: 0,
    }),
  ).toEqual({ zoomGesture: true, direction: null });
  expect(
    consumeWheelZoomEvent(state, {
      timeStamp: resumeAt + 40,
      zoomModifier: true,
      deltaY: -15,
      deltaMode: 0,
    }),
  ).toEqual({ zoomGesture: true, direction: 1 });

  // Discrete line-mode mouse wheels still trigger on a single small delta.
  expect(
    consumeWheelZoomEvent(state, {
      timeStamp: resumeAt + 60,
      zoomModifier: true,
      deltaY: 1,
      deltaMode: 1,
    }),
  ).toEqual({ zoomGesture: true, direction: -1 });
});
