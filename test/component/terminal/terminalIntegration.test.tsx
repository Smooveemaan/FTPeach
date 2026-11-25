import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import ConnectionBar from '../../../src/features/connections/ConnectionBar.tsx';
import PaneSourceSwitcher from '../../../src/features/file-browser/components/PaneSourceSwitcher.tsx';
import { FilePane } from '../../../src/features/file-browser/index.ts';
import { createPaneSessionLifecycle } from '../../../src/features/file-browser/panes/createPaneSessionLifecycle.ts';
import { initialForm, makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
import {
  createTerminalStore,
  terminalStore,
  useTerminalSession,
} from '../../../src/features/terminal/index.ts';
import type { TerminalStore, XtermInstance } from '../../../src/features/terminal/index.ts';
import { TerminalPanel } from '../../../src/features/terminal/ui.ts';
import type {
  TerminalApi,
  TerminalEvent,
  TerminalOpenResult,
} from '../../../src/platform/api/terminal.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';
import type { ManagedSite } from '../../../src/shared/siteContracts.ts';

function makeFakeXterm(): XtermInstance & {
  openedContainers: HTMLElement[];
  disposed: boolean;
  setSelection: (_text: string) => void;
} {
  const openedContainers: HTMLElement[] = [];
  let disposed = false;
  let selection = '';
  let selectionHandler: (() => void) | null = null;
  return {
    cols: 80,
    rows: 24,
    openedContainers,
    get disposed() {
      return disposed;
    },
    setSelection(text) {
      selection = text;
      selectionHandler?.();
    },
    open(container) {
      openedContainers.push(container);
      const marker = document.createElement('div');
      marker.className = 'xterm-fake-screen';
      marker.textContent = 'prompt$ ';
      container.appendChild(marker);
    },
    fit() {
      return { cols: 80, rows: 24 };
    },
    refresh() {},
    getScrollFromBottom() {
      return 0;
    },
    restoreScrollFromBottom() {},
    write(_data, cb) {
      cb?.();
    },
    clear() {},
    selectAll() {
      selection = 'copied';
      selectionHandler?.();
    },
    clearSelection() {
      selection = '';
      selectionHandler?.();
    },
    getSelection() {
      return selection;
    },
    hasSelection() {
      return selection.length > 0;
    },
    focus() {},
    paste() {},
    setTheme() {},
    setFontSize() {},
    onData() {
      return { dispose() {} };
    },
    onSelectionChange(fn) {
      selectionHandler = fn;
      return {
        dispose() {
          selectionHandler = null;
        },
      };
    },
    attachCustomKeyEventHandler() {},
    dispose() {
      disposed = true;
    },
  };
}

function makeFakeApi(
  openResult: TerminalOpenResult = { ok: true, outcome: 'opened', terminalId: 'term-1' },
) {
  let listener: ((_event: TerminalEvent) => void) | null = null;
  const open = vi.fn(
    async (
      _connectionId: string,
      _cols: number,
      _rows: number,
      onEvent: (_event: TerminalEvent) => void,
    ): Promise<TerminalOpenResult> => {
      listener = onEvent;
      return openResult;
    },
  );
  const close = vi.fn(async () => ({ ok: true as const }));
  const api: TerminalApi = {
    open,
    write: vi.fn(async () => ({ ok: true as const })),
    resize: vi.fn(async () => ({ ok: true as const })),
    ack: vi.fn(async () => ({ ok: true as const })),
    close,
  };
  return {
    api,
    open,
    close,
    emit(event: TerminalEvent) {
      listener?.(event);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('ConnectionBar enables terminal button only for SFTP and invokes connect-with-terminal', () => {
  const onOpenTerminal = vi.fn();
  const baseProps = {
    onChange: vi.fn(),
    status: 'idle' as const,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onCancelConnect: vi.fn(),
    onSaveSite: vi.fn(),
    onOpenTerminal,
    onOpenSiteManager: vi.fn(),
    connectionVisualState: 'idle' as const,
  };

  const { container, rerender } = render(
    <ConnectionBar
      {...baseProps}
      form={{ ...initialForm, protocol: 'ftp', host: 'ftp.example.com' }}
    />,
  );
  const ftpBtn = container.querySelector<HTMLButtonElement>('[data-action="toggle-terminal"]')!;
  expect(ftpBtn.disabled).toBe(true);
  expect(ftpBtn.getAttribute('data-tooltip')).toBe(
    'SSH terminal is available only for SFTP connections',
  );

  rerender(
    <ConnectionBar
      {...baseProps}
      form={{ ...initialForm, protocol: 'sftp', host: 'sftp.example.com' }}
    />,
  );
  const sftpBtn = container.querySelector<HTMLButtonElement>('[data-action="toggle-terminal"]')!;
  expect(sftpBtn.disabled).toBe(false);
  fireEvent.click(sftpBtn);
  expect(onOpenTerminal).toHaveBeenCalledOnce();
});

test('PaneSourceSwitcher shows active terminal toggle when connected via SFTP and disables it for WebDAV', () => {
  const onToggleTerminal = vi.fn();
  const baseProps = {
    orderedSites: [],
    localPaths: [],
    formatDate: () => '',
    onSwitchLocal: vi.fn(),
    onStartConnect: vi.fn(),
    onFormChange: vi.fn(),
    onDismissError: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onCancelConnect: vi.fn(),
    onSiteConnect: vi.fn(),
    onLocalPathOpen: vi.fn(),
    onSaveSite: vi.fn(),
    onToggleTerminal,
    onOpenSiteManager: vi.fn(),
    onOpenLocalPathManager: vi.fn(),
  };

  const { container, rerender } = render(
    <PaneSourceSwitcher
      {...baseProps}
      terminalActive={false}
      pane={{
        kind: 'remote',
        status: 'connected',
        siteLabel: 'DAV',
        siteId: null,
        form: { ...initialForm, protocol: 'webdav', webdavUrl: 'https://dav.example.com' },
        errorMessage: '',
      }}
    />,
  );
  const davBtn = container.querySelector<HTMLButtonElement>('[data-action="toggle-terminal"]')!;
  expect(davBtn.disabled).toBe(true);

  rerender(
    <PaneSourceSwitcher
      {...baseProps}
      terminalActive
      pane={{
        kind: 'remote',
        status: 'connected',
        siteLabel: 'SSH',
        siteId: null,
        form: { ...initialForm, protocol: 'sftp', host: 'ssh.example.com' },
        errorMessage: '',
      }}
    />,
  );
  const sftpBtn = container.querySelector<HTMLButtonElement>('[data-action="toggle-terminal"]')!;
  expect(sftpBtn.disabled).toBe(false);
  expect(sftpBtn.getAttribute('aria-pressed')).toBe('true');
  expect(sftpBtn.classList.contains('active')).toBe(true);
  fireEvent.click(sftpBtn);
  expect(onToggleTerminal).toHaveBeenCalledOnce();
});

test('TerminalPanel supports split -> collapsed -> maximized -> closed and survives tab unmount/remount', async () => {
  const fakeXterm = makeFakeXterm();
  const fakeApi = makeFakeApi();
  const store = createTerminalStore({
    terminalApi: () => fakeApi.api,
    createXterm: async () => fakeXterm,
  });

  function Harness({ tab, activeStore }: { tab: string; activeStore: TerminalStore }) {
    const session = useTerminalSession(tab === 'sftp-tab' ? 'conn-1' : null, activeStore);
    return session ? (
      <TerminalPanel session={session} store={activeStore} />
    ) : (
      <div data-testid="empty" />
    );
  }

  const { container, rerender } = render(<Harness tab="sftp-tab" activeStore={store} />);
  await act(async () => {
    await store.open('conn-1');
  });

  await waitFor(() => {
    expect(container.querySelector('.terminal-panel')?.getAttribute('data-terminal-mode')).toBe(
      'split',
    );
    expect(container.querySelector('.xterm-fake-screen')).not.toBeNull();
  });
  const firstScreenNode = container.querySelector('.xterm-fake-screen');

  // Header copy button reacts to xterm selection state; paste is enabled while open.
  const copyBtn = container.querySelector<HTMLButtonElement>('[data-action="terminal-copy"]')!;
  const pasteBtn = container.querySelector<HTMLButtonElement>('[data-action="terminal-paste"]')!;
  expect(copyBtn.disabled).toBe(true);
  expect(pasteBtn.disabled).toBe(false);
  act(() => {
    fakeXterm.setSelection('hello');
  });
  expect(copyBtn.disabled).toBe(false);

  // Switch away to another tab, then switch back: the live xterm DOM node is preserved.
  rerender(<Harness tab="other-tab" activeStore={store} />);
  expect(screen.getByTestId('empty')).toBeTruthy();
  expect(fakeXterm.disposed).toBe(false);

  rerender(<Harness tab="sftp-tab" activeStore={store} />);
  expect(container.querySelector('.xterm-fake-screen')).toBe(firstScreenNode);
  expect(fakeXterm.openedContainers).toHaveLength(1);

  // Collapse -> Expand -> Maximize -> Restore -> Close.
  fireEvent.click(container.querySelector('[data-action="terminal-collapse"]')!);
  expect(container.querySelector('.terminal-panel')?.getAttribute('data-terminal-mode')).toBe(
    'collapsed',
  );

  fireEvent.click(container.querySelector('[data-action="terminal-collapse"]')!);
  expect(container.querySelector('.terminal-panel')?.getAttribute('data-terminal-mode')).toBe(
    'split',
  );

  fireEvent.click(container.querySelector('[data-action="terminal-maximize"]')!);
  expect(container.querySelector('.terminal-panel')?.getAttribute('data-terminal-mode')).toBe(
    'maximized',
  );

  fireEvent.click(container.querySelector('[data-action="terminal-maximize"]')!);
  expect(container.querySelector('.terminal-panel')?.getAttribute('data-terminal-mode')).toBe(
    'split',
  );

  fireEvent.click(container.querySelector('[data-action="terminal-close"]')!);
  expect(screen.getByTestId('empty')).toBeTruthy();
  expect(fakeXterm.disposed).toBe(true);
  expect(fakeApi.close).toHaveBeenCalledWith('term-1');
});

test('TerminalPanel renders shellRefused notice and exit reconnect button in header', async () => {
  const refusedApi = makeFakeApi({
    ok: true,
    outcome: 'shellRefused',
    message: 'Server refused shell',
  });
  const refusedStore = createTerminalStore({
    terminalApi: () => refusedApi.api,
    createXterm: async () => makeFakeXterm(),
  });

  function Harness({ activeStore }: { activeStore: TerminalStore }) {
    const session = useTerminalSession('conn-1', activeStore);
    return session ? <TerminalPanel session={session} store={activeStore} /> : null;
  }

  const { container, unmount } = render(<Harness activeStore={refusedStore} />);
  await act(async () => {
    await refusedStore.open('conn-1');
  });
  expect(container.querySelector('.terminal-panel-status.is-refused')).not.toBeNull();
  expect(container.querySelector('[data-action="terminal-reconnect"]')).toBeNull();
  expect(
    container.querySelector<HTMLButtonElement>('[data-action="terminal-paste"]')?.disabled,
  ).toBe(true);
  unmount();

  const exitApi = makeFakeApi();
  const exitStore = createTerminalStore({
    terminalApi: () => exitApi.api,
    createXterm: async () => makeFakeXterm(),
  });
  const view = render(<Harness activeStore={exitStore} />);
  await act(async () => {
    await exitStore.open('conn-1');
  });
  act(() => {
    exitApi.emit({ event: 'exit', code: 130 });
  });
  const statusEl = view.container.querySelector('.terminal-panel-status.is-exited.is-nonzero');
  expect(statusEl).not.toBeNull();
  expect(statusEl?.textContent).toContain('130');
  const actionsOrder = Array.from(
    view.container.querySelectorAll('.terminal-panel-actions > *'),
  ).map((el) => (el.classList.contains('toolbar-divider') ? '|' : el.getAttribute('data-action')));
  expect(actionsOrder).toEqual([
    'terminal-reconnect',
    '|',
    'terminal-copy',
    'terminal-paste',
    '|',
    'terminal-collapse',
    'terminal-maximize',
    'terminal-close',
  ]);
  const reconnectBtn = view.container.querySelector<HTMLButtonElement>(
    '[data-action="terminal-reconnect"]',
  )!;
  await act(async () => {
    fireEvent.click(reconnectBtn);
  });
  expect(exitApi.open).toHaveBeenCalledTimes(2);
});

test('FilePane terminal divider drags smoothly across collapsed, split, and maximized states and keeps pane focus', () => {
  window.api = {
    ...tauriApi,
    fsLocal: {
      ...tauriApi.fsLocal,
      onOsDragDrop: vi.fn(() => vi.fn()),
      setDropAllowed: vi.fn(),
    },
  };

  const onTerminalModeChange = vi.fn();
  const onTerminalSplitChange = vi.fn();
  const onTerminalSplitCommit = vi.fn();

  const baseProps = {
    side: 'b' as const,
    kind: 'remote' as const,
    crumbs: [{ label: '/', path: '/' }],
    entries: [],
    selectedNames: new Set<string>(),
    onCrumbClick: vi.fn(),
    onSelectionChange: vi.fn(),
    onRowDoubleClick: vi.fn(),
    loading: false,
    disconnected: false,
    dragMoveStart: vi.fn(),
    outboundDragRef: { current: false },
    availableColumns: ['size', 'modifiedAt'] as const,
    visibleColumns: ['size', 'modifiedAt'] as const,
    columnWidths: {},
    terminalSlot: (
      <div className="terminal-panel-body">
        <textarea data-testid="term-input" />
      </div>
    ),
    terminalSplitRatio: 0.5,
    onTerminalSplitChange,
    onTerminalSplitCommit,
    onTerminalModeChange,
  };

  const { container, rerender } = render(<FilePane {...baseProps} terminalMode="collapsed" />);
  const pane = container.querySelector<HTMLElement>('.pane')!;
  const resizer = container.querySelector<HTMLElement>('.terminal-resizer')!;
  const splitArea = container.querySelector<HTMLElement>('.pane-split-area')!;
  expect(resizer.hidden).toBe(false);

  vi.spyOn(splitArea, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 500,
    left: 0,
    right: 600,
    width: 600,
    height: 400,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  });

  // Double-clicking the collapsed divider expands it.
  fireEvent.doubleClick(resizer);
  expect(onTerminalModeChange).toHaveBeenCalledWith('split');
  onTerminalModeChange.mockClear();

  // A stray click inside the 4px deadzone does not expand or commit.
  fireEvent.mouseDown(resizer, { clientY: 470 });
  expect(document.body.classList.contains('resize-active')).toBe(true);
  fireEvent.mouseMove(document, { clientY: 468 });
  fireEvent.mouseUp(document);
  expect(document.body.classList.contains('resize-active')).toBe(false);
  expect(onTerminalModeChange).not.toHaveBeenCalled();
  expect(onTerminalSplitCommit).not.toHaveBeenCalled();

  // Dragging upward from collapsed expands smoothly and commits the split ratio.
  fireEvent.mouseDown(resizer, { clientY: 470 });
  fireEvent.mouseMove(document, { clientY: 300 });
  expect(onTerminalModeChange).toHaveBeenCalledWith('split');
  expect(onTerminalSplitChange).toHaveBeenCalledWith(0.5);
  fireEvent.mouseUp(document);
  expect(onTerminalSplitCommit).toHaveBeenCalledWith(0.5);

  // Dragging near the top stays in split mode smoothly; only reaching the top edge maximizes.
  onTerminalModeChange.mockClear();
  onTerminalSplitChange.mockClear();
  onTerminalSplitCommit.mockClear();
  rerender(<FilePane {...baseProps} terminalMode="split" terminalSplitRatio={0.5} />);
  fireEvent.mouseDown(resizer, { clientY: 300 });
  fireEvent.mouseMove(document, { clientY: 120 });
  expect(onTerminalModeChange).not.toHaveBeenCalled();
  expect(onTerminalSplitChange).toHaveBeenLastCalledWith(377 / 394);
  fireEvent.mouseMove(document, { clientY: 102 });
  expect(onTerminalModeChange).toHaveBeenCalledWith('maximized');
  fireEvent.mouseUp(document);
  expect(onTerminalSplitCommit).not.toHaveBeenCalled();
  expect(onTerminalSplitChange).toHaveBeenLastCalledWith(0.5);

  // Dragging near the bottom stays in split mode smoothly; reaching the header collapses.
  onTerminalModeChange.mockClear();
  onTerminalSplitChange.mockClear();
  onTerminalSplitCommit.mockClear();
  fireEvent.mouseDown(resizer, { clientY: 300 });
  fireEvent.mouseMove(document, { clientY: 460 });
  expect(onTerminalModeChange).not.toHaveBeenCalled();
  expect(onTerminalSplitChange).toHaveBeenLastCalledWith(37 / 394);
  fireEvent.mouseMove(document, { clientY: 470 });
  expect(onTerminalModeChange).toHaveBeenCalledWith('collapsed');
  fireEvent.mouseUp(document);
  expect(onTerminalSplitCommit).not.toHaveBeenCalled();
  expect(onTerminalSplitChange).toHaveBeenLastCalledWith(0.5);

  // In maximized mode the top edge resizer stays interactive (double-click or drag down restores split).
  onTerminalModeChange.mockClear();
  onTerminalSplitChange.mockClear();
  onTerminalSplitCommit.mockClear();
  rerender(<FilePane {...baseProps} terminalMode="maximized" terminalSplitRatio={0.5} />);
  expect(resizer.hidden).toBe(false);
  fireEvent.doubleClick(resizer);
  expect(onTerminalModeChange).toHaveBeenCalledWith('split');
  onTerminalModeChange.mockClear();
  fireEvent.mouseDown(resizer, { clientY: 102 });
  fireEvent.mouseMove(document, { clientY: 104 });
  fireEvent.mouseUp(document);
  expect(onTerminalModeChange).not.toHaveBeenCalled();
  fireEvent.mouseDown(resizer, { clientY: 102 });
  fireEvent.mouseMove(document, { clientY: 300 });
  expect(onTerminalModeChange).toHaveBeenCalledWith('split');
  expect(onTerminalSplitChange).toHaveBeenCalledWith(0.5);
  fireEvent.mouseUp(document);
  expect(onTerminalSplitCommit).toHaveBeenCalledWith(0.5);

  // Collapsing while focus is inside the terminal keeps focus on the pane.
  rerender(<FilePane {...baseProps} terminalMode="split" terminalSplitRatio={0.5} />);
  const termInput = screen.getByTestId('term-input');
  act(() => termInput.focus());
  expect(document.activeElement).toBe(termInput);
  rerender(<FilePane {...baseProps} terminalMode="collapsed" terminalSplitRatio={0.5} />);
  expect(document.activeElement).toBe(pane);
});

test('siteConnectPane auto-opens terminal for SFTP bookmarks with openTerminalOnConnect and disconnect closes it', async () => {
  const openSpy = vi.spyOn(terminalStore, 'open').mockResolvedValue(undefined);
  const closeSpy = vi.spyOn(terminalStore, 'close').mockImplementation(() => {});

  const panes = { a: makePane('a', 'local'), b: makePane('b', 'remote') };
  const requestIds: Record<string, { a: number; b: number }> = { t1: { a: 0, b: 0 } };
  const lifecycle = createPaneSessionLifecycle({
    client: {
      session: {
        connect: vi.fn(async () => ({ ok: true as const })),
        cancelConnect: vi.fn(async () => ({ ok: true as const })),
        disconnect: vi.fn(async () => ({ ok: true as const })),
        list: vi.fn(async () => ({ ok: true as const, entries: [] })),
        mkdir: vi.fn(async () => ({ ok: true as const })),
        createFile: vi.fn(async () => ({ ok: true as const })),
        delete: vi.fn(async () => ({ ok: true as const })),
        rename: vi.fn(async () => ({ ok: true as const })),
        chmod: vi.fn(async () => ({ ok: true as const })),
        trustHostKey: vi.fn(async () => ({ ok: true as const })),
      },
    },
    connectTimeout: 5000,
    ftpActiveMode: false,
    panes,
    activeTabId: 't1',
    setTabs: vi.fn(),
    updatePane: (id, patch) => {
      Object.assign(panes[id], typeof patch === 'function' ? patch(panes[id]) : patch);
    },
    ensureRequestIds: (tabId) => (requestIds[tabId] ??= { a: 0, b: 0 }),
    refreshPane: vi.fn(async () => ({ ok: true as const })),
    pushRecentSite: vi.fn(),
    onVaultUnlockRequired: vi.fn(),
    inFlightRefreshesRef: { current: {} },
    stopTransfersForConnection: vi.fn(async () => {}),
  });

  const sftpSite: ManagedSite = {
    id: 'site-1',
    kind: 'site',
    name: 'Prod SSH',
    protocol: 'sftp',
    host: 'prod.example.com',
    port: 22,
    webdavUrl: '',
    user: 'ubuntu',
    remotePath: '/srv',
    allowInvalidCert: false,
    allowCleartextAuth: false,
    caCertPath: '',
    encoding: '',
    maxConnections: null,
    useKeyAuth: true,
    keyPath: '/home/u/.ssh/id_ed25519',
    openTerminalOnConnect: true,
    hasPassword: false,
    hasKeyPassphrase: false,
    localPath: '',
    parentId: null,
    icon: 'bookmark',
    color: '',
  };

  lifecycle.siteConnectPane('b', sftpSite, 't1');
  await waitFor(() => {
    expect(openSpy).toHaveBeenCalledOnce();
  });
  const openedConnId = openSpy.mock.calls[0]?.[0];
  expect(openedConnId).toBe(panes.b.connectionId);

  await lifecycle.disconnectPane('b', 't1');
  expect(closeSpy).toHaveBeenCalledWith(openedConnId);
});

test('TerminalPanel renders directional move-pane button and docked source label', async () => {
  const fakeXterm = makeFakeXterm();
  const fakeApi = makeFakeApi();
  const store = createTerminalStore({
    terminalApi: () => fakeApi.api,
    createXterm: async () => fakeXterm,
  });

  await act(async () => {
    await store.open('conn-move');
  });

  const session = store.getSession('conn-move')!;
  const { container, rerender } = render(
    <TerminalPanel session={session} store={store} movePaneDirection="left" />,
  );

  const moveBtn = container.querySelector<HTMLButtonElement>('[data-action="terminal-move-pane"]')!;
  expect(moveBtn).not.toBeNull();
  expect(moveBtn.getAttribute('aria-label')).toBe('Move terminal to pane on the left');
  expect(container.querySelector('[data-action="terminal-collapse"]')).not.toBeNull();
  expect(container.querySelector('[data-action="terminal-maximize"]')).not.toBeNull();

  fireEvent.click(moveBtn);
  expect(store.getSession('conn-move')?.dock).toBe('other');
  expect(fakeApi.open).toHaveBeenCalledOnce();

  rerender(
    <TerminalPanel
      session={store.getSession('conn-move')!}
      store={store}
      dockedInOtherPane
      sourceLabel="Prod SSH"
      movePaneDirection="below"
    />,
  );
  expect(container.querySelector('.terminal-panel-source')?.textContent).toBe('Prod SSH');
  expect(
    container.querySelector('[data-action="terminal-move-pane"]')?.getAttribute('aria-label'),
  ).toBe('Move terminal to pane below');
  expect(container.querySelector('[data-action="terminal-collapse"]')).toBeNull();
  expect(container.querySelector('[data-action="terminal-maximize"]')).toBeNull();
});
