// What a pane does when the user acts on it, followed from the props FilePane
// receives to the owner that carries the action out. FilePane itself is
// replaced by a stub that records its props; everything between it and the
// owners (panes, clipboard, transfers, dialogs, IPC) is production code.
import type { ComponentProps, ReactElement } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import FileBrowserPane from '../../../src/features/file-browser/FileBrowserPane.tsx';
import type { FilePaneProps } from '../../../src/features/file-browser/FilePane.tsx';
import type PaneSourceSwitcher from '../../../src/features/file-browser/components/PaneSourceSwitcher.tsx';
import type PaneToolbar from '../../../src/features/file-browser/components/PaneToolbar.tsx';
import type { FileClipboardModel } from '../../../src/features/file-browser/useFileClipboard.ts';
import type { PanesModel } from '../../../src/features/file-browser/usePanes.ts';
import { paneJoin } from '../../../src/features/file-browser/panes/paneBackend.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneId, PaneState } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { FileEntry } from '../../../src/shared/paneContracts.ts';
import type { ManagedSite } from '../../../src/shared/siteContracts.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

let filePane: FilePaneProps | null = null;
vi.mock('../../../src/features/file-browser/FilePane.tsx', () => ({
  default: (props: FilePaneProps) => {
    filePane = props;
    return null;
  },
}));

afterEach(() => {
  filePane = null;
  document.documentElement.dir = '';
});

type PaneSourceSwitcherProps = ComponentProps<typeof PaneSourceSwitcher>;
type PaneToolbarProps = ComponentProps<typeof PaneToolbar>;

const file = (name: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  name,
  isDirectory: false,
  size: 7,
  ...overrides,
});

const localPane = (overrides: Partial<PaneState> = {}): PaneState => ({
  ...makePane('a', 'local'),
  path: 'C:\\work',
  entries: [file('report.pdf'), file('setup.exe'), file('docs', { isDirectory: true })],
  ...overrides,
});

const serverPane = (overrides: Partial<PaneState> = {}): PaneState => ({
  ...makePane('b', 'remote'),
  status: 'connected',
  connectionId: 'session-b',
  protocol: 'sftp',
  siteId: 'site-1',
  path: '/deep/inside',
  entries: [file('notes.txt')],
  ...overrides,
});

const bookmark: ManagedSite = {
  id: 'site-1',
  name: 'Bookmark',
  protocol: 'sftp',
  host: 'example.test',
  remotePath: '/current/start',
};

interface HarnessOptions {
  a?: PaneState;
  b?: PaneState;
  sites?: ManagedSite[];
  driveMenu?: { id: PaneId } | null;
}

function harness({ a, b, sites = [bookmark], driveMenu = null }: HarnessOptions = {}) {
  const connect = vi.fn();
  const goHome = vi.fn(async () => {});
  const chooseFolder = vi.fn(async () => {});
  const saveNow = vi.fn();
  const browser = {
    panes: { a: a ?? localPane(), b: b ?? serverPane() },
    activeTabId: 'tab-1',
    paneJoin,
    crumbsFor: vi.fn(() => [{ label: 'root', path: '/' }]),
    navigatePane: vi.fn(async () => {}),
    openDirectory: vi.fn(),
    updatePane: vi.fn(),
    refreshPane: vi.fn(async () => {}),
    refreshPaneIfAt: vi.fn(async () => {}),
    renamePaneEntry: vi.fn(async () => {}),
    deletePaneSelected: vi.fn(),
    deletePaneEntry: vi.fn(),
    goPaneBack: vi.fn(),
    goPaneForward: vi.fn(),
    paneParent: vi.fn(),
    goPaneHome: vi.fn(() => goHome),
    chooseLocalDir: vi.fn(() => chooseFolder),
    switchPaneToLocal: vi.fn(),
    startPaneConnect: vi.fn(),
    setPaneForm: vi.fn(),
    connectPane: vi.fn(() => connect),
    disconnectPane: vi.fn(async () => {}),
    cancelConnectPane: vi.fn(),
    siteConnectPane: vi.fn(),
    activatePane: vi.fn(),
    canCopyBetween: vi.fn(() => true),
  };
  const clipboard = {
    copyToClipboard: vi.fn(),
    cutToClipboard: vi.fn(),
    canPaste: vi.fn(() => true),
    cutNames: vi.fn(() => undefined),
    pasteClipboard: vi.fn(),
    copySelectedWithConfirm: vi.fn(async () => {}),
    dragMove: { startDrag: vi.fn() },
    outboundDragRef: { current: false },
  };
  const dialogs = {
    driveMenu,
    setDriveMenu: vi.fn(),
    setNewFolderTarget: vi.fn(),
    setNewFileTarget: vi.fn(),
    setMoveToTarget: vi.fn(),
    setChmodTarget: vi.fn(),
    setShowSiteManagerDialog: vi.fn(),
    setShowLocalPathManagerDialog: vi.fn(),
  };
  const transfers = { copyEntries: vi.fn(), handleOsDropFiles: vi.fn() };
  const openWith = { setTarget: vi.fn() };
  const saveSite = vi.fn(() => saveNow);
  const reportError = vi.fn();
  const openPath = vi.fn(async (_path: string) => ({ ok: true }) as Record<string, unknown>);
  const drives = vi.fn(async () => [
    { label: 'C:', path: 'C:\\' },
    { label: 'D:', path: 'D:\\' },
  ]);
  window.api = { fsLocal: { openPath, drives } } as unknown as Window['api'];

  const h = {
    browser,
    clipboard,
    dialogs,
    transfers,
    openWith,
    saveSite,
    saveNow,
    reportError,
    sites,
    connect,
    goHome,
    chooseFolder,
    openPath,
    drives,
  };
  return {
    ...h,
    mount(id: PaneId, orientation: 'horizontal' | 'vertical' = 'horizontal') {
      render(mount(h, id, orientation));
      return filePane!;
    },
    title: () => (filePane!.titleSlot as ReactElement<PaneSourceSwitcherProps>).props,
    toolbar: () => (filePane!.toolbar as ReactElement<PaneToolbarProps>).props,
  };
}
type Harness = Omit<ReturnType<typeof harness>, 'mount' | 'title' | 'toolbar'>;

// The only place that knows how Application puts a pane together.
function mount(h: Harness, id: PaneId, orientation: 'horizontal' | 'vertical') {
  return (
    <FileBrowserPane
      id={id}
      style={{}}
      searchInputRef={{ current: null }}
      browser={h.browser as unknown as PanesModel}
      clipboard={h.clipboard as unknown as FileClipboardModel}
      sites={{ connectableSites: h.sites, orderedSites: h.sites, localPaths: [] }}
      settings={{
        layout: {
          showHiddenFiles: false,
          localColumns: { a: [], b: [] },
          remoteColumns: { a: [], b: [] },
          localColumnWidths: { a: {}, b: {} },
          remoteColumnWidths: { a: {}, b: {} },
        },
        shortcuts: { keyboardShortcuts: {} },
      }}
      columns={{
        changeLocalColumns: () => vi.fn(),
        changeRemoteColumns: () => vi.fn(),
        changeLocalColumnWidths: () => vi.fn(),
        changeRemoteColumnWidths: () => vi.fn(),
      }}
      paneOrientation={orientation}
      shell={{
        dialogs: h.dialogs,
        transfers: h.transfers,
        openWith: h.openWith,
        saveSite: h.saveSite,
        reportError: h.reportError,
      }}
    />
  );
}

describe('reconnecting a pane', () => {
  test('a pane from a bookmark reconnects through the bookmark as it is now', () => {
    const h = harness({ b: serverPane({ status: 'idle', connectionId: null, path: '/' }) });
    h.mount('b');
    h.title().onConnect();
    expect(h.browser.siteConnectPane).toHaveBeenCalledWith('b', bookmark);
    expect(h.connect).not.toHaveBeenCalled();
  });

  test('a pane whose bookmark is gone reconnects with the form it has', () => {
    const h = harness({ b: serverPane({ status: 'idle', siteId: 'deleted' }) });
    h.mount('b');
    h.title().onConnect();
    expect(h.browser.connectPane).toHaveBeenCalledWith('b');
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.browser.siteConnectPane).not.toHaveBeenCalled();
  });

  test('a saved local path opens in the pane', () => {
    const h = harness();
    h.mount('a');
    h.title().onLocalPathOpen?.({ id: 'p', name: 'Photos', kind: 'local', localPath: 'D:\\p' });
    expect(h.browser.switchPaneToLocal).toHaveBeenCalledWith('a', 'tab-1', 'D:\\p');
  });
});

describe('opening a file', () => {
  test('a local document and a local program both go to openPath', async () => {
    const h = harness();
    const pane = h.mount('a');
    await act(async () => pane.onRowDoubleClick?.(file('report.pdf')));
    await act(async () => pane.onRowDoubleClick?.(file('setup.exe')));
    expect(h.openPath.mock.calls).toEqual([['C:\\work\\report.pdf'], ['C:\\work\\setup.exe']]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  test('declining to run a program reports nothing, and a real failure is reported', async () => {
    const h = harness();
    const pane = h.mount('a');
    h.openPath.mockResolvedValueOnce({
      ok: false,
      error: 'Operation cancelled',
      errorCode: 'cancelled',
    });
    await act(async () => pane.onRowDoubleClick?.(file('setup.exe')));
    expect(h.reportError).not.toHaveBeenCalled();

    h.openPath.mockResolvedValueOnce({ ok: false, error: 'gone', errorCode: 'notFound' });
    await act(async () => pane.onRowDoubleClick?.(file('report.pdf')));
    expect(h.reportError).toHaveBeenCalledExactlyOnceWith({ code: 'notFound', message: 'gone' });
  });

  test('a folder opens in the pane and a server file opens with its program', () => {
    const h = harness();
    h.mount('a').onRowDoubleClick?.(file('docs', { isDirectory: true }));
    expect(h.browser.openDirectory).toHaveBeenCalledWith('a', 'docs');

    h.mount('b').onRowDoubleClick?.(file('notes.txt', { size: 42 }));
    expect(h.openWith.setTarget).toHaveBeenCalledWith({
      path: '/deep/inside/notes.txt',
      size: 42,
      connectionId: 'session-b',
      paneId: 'b',
      tabId: 'tab-1',
    });
    expect(h.openPath).not.toHaveBeenCalled();
  });
});

describe('dropping files from the system', () => {
  const dropped = [
    { name: 'one.txt', path: 'E:\\one.txt', isDirectory: false },
    { name: 'two.txt', path: 'E:\\two.txt', isDirectory: false },
  ];

  test('hands the drop to transfers and refreshes the originating pane', async () => {
    const h = harness();
    h.mount('a').onDropFiles?.(dropped, 'docs');
    const [target, files, folder, refresh] = h.transfers.handleOsDropFiles.mock
      .calls[0] as unknown as [PaneState, unknown, string, () => void];
    expect([target, files, folder]).toEqual([h.browser.panes.a, dropped, 'docs']);
    refresh();
    expect(h.browser.refreshPane).toHaveBeenCalledWith('a', 'C:\\work');
  });

  test('a drop on the listing itself has no target folder', () => {
    const h = harness();
    h.mount('b').onDropFiles?.(dropped, null);
    expect(h.transfers.handleOsDropFiles.mock.calls[0]?.[2]).toBeNull();
    expect(h.transfers.handleOsDropFiles.mock.calls[0]).toHaveLength(4);
  });
});

describe('going home', () => {
  test('a server pane goes to its bookmark folder, or to the root without one', () => {
    const h = harness();
    h.mount('b');
    h.toolbar().onHome();
    filePane!.onNavigateHome?.();
    expect(h.browser.navigatePane.mock.calls).toEqual([
      ['b', '/current/start'],
      ['b', '/current/start'],
    ]);

    const loose = harness({ b: serverPane({ siteId: null }) });
    loose.mount('b');
    loose.toolbar().onHome();
    expect(loose.browser.navigatePane).toHaveBeenCalledWith('b', '/');
  });

  test('a disconnected server pane stays put and a local pane goes to the home folder', () => {
    const h = harness({ b: serverPane({ status: 'idle' }) });
    h.mount('b');
    h.toolbar().onHome();
    expect(h.browser.navigatePane).not.toHaveBeenCalled();

    h.mount('a');
    h.toolbar().onHome();
    expect(h.browser.goPaneHome).toHaveBeenCalledWith('a');
    expect(h.goHome).toHaveBeenCalledOnce();
  });
});

describe('moving and copying the selection', () => {
  test('Move to offers the folders that are not being moved', () => {
    const h = harness({ a: localPane({ selected: new Set(['report.pdf', 'docs']) }) });
    h.mount('a').onMoveTo?.(['archive', 'docs']);
    expect(h.dialogs.setMoveToTarget).toHaveBeenCalledWith({
      id: 'a',
      names: ['report.pdf', 'docs'],
      folders: ['archive'],
    });
  });

  test('Move to with nowhere to move opens nothing', () => {
    const h = harness({ a: localPane({ selected: new Set(['docs']) }) });
    h.mount('a').onMoveTo?.(['docs']);
    expect(h.dialogs.setMoveToTarget).not.toHaveBeenCalled();
  });

  test.each([
    ['horizontal', 'a', 'filePane.copyToPaneRight'],
    ['horizontal', 'b', 'filePane.copyToPaneLeft'],
    ['vertical', 'a', 'filePane.copyToPaneBelow'],
    ['vertical', 'b', 'filePane.copyToPaneAbove'],
  ] as const)(
    'copying to the other pane names where it goes (%s, %s)',
    (orientation, id, label) => {
      harness().mount(id, orientation);
      expect((filePane!.toolbar as ReactElement<PaneToolbarProps>).props.copyLabel).toBe(label);
    },
  );

  test('copying to the other pane refreshes both panes', () => {
    const h = harness();
    const pane = h.mount('a');
    pane.onCopyToOtherPane?.();
    h.toolbar().onCopy();
    expect(h.clipboard.copySelectedWithConfirm).toHaveBeenCalledTimes(2);
    for (const call of h.clipboard.copySelectedWithConfirm.mock.calls as unknown as [
      PaneState,
      PaneState,
      () => void,
      () => void,
    ][]) {
      expect(call.slice(0, 2)).toEqual([h.browser.panes.a, h.browser.panes.b]);
      call[2]();
      call[3]();
    }
    expect(h.browser.refreshPaneIfAt.mock.calls).toEqual([
      ['a', 'C:\\work'],
      ['b', '/deep/inside'],
      ['a', 'C:\\work'],
      ['b', '/deep/inside'],
    ]);
  });

  test('copying to the other pane is not offered when the panes cannot exchange files', () => {
    const h = harness();
    h.browser.canCopyBetween.mockReturnValue(false);
    expect(h.mount('a').onCopyToOtherPane).toBeUndefined();
    expect(h.toolbar().copyDisabled).toBe(true);
  });
});

describe('the drive menu', () => {
  const click = (rect: Partial<DOMRect>) =>
    ({ currentTarget: { getBoundingClientRect: () => rect } }) as never;

  test('lists the drives under the crumb, ticks the current one and navigates', async () => {
    const h = harness({ a: localPane({ path: 'd:\\music' }) });
    const pane = h.mount('a');
    await act(async () => pane.onDriveMenuOpen?.(click({ left: 10, right: 90, bottom: 30 })));
    const menu = h.dialogs.setDriveMenu.mock.calls[0]?.[0] as {
      id: PaneId;
      x: number;
      y: number;
      items: { label: string; checked: boolean; onClick: () => void }[];
    };
    expect(menu).toMatchObject({ id: 'a', x: 10, y: 30 });
    expect(menu.items.map(({ label, checked }) => [label, checked])).toEqual([
      ['C:', false],
      ['D:', true],
    ]);
    menu.items[0]!.onClick();
    expect(h.browser.navigatePane).toHaveBeenCalledWith('a', 'C:\\');
  });

  test('opens from the right edge in a right-to-left layout', async () => {
    document.documentElement.dir = 'rtl';
    const h = harness();
    const pane = h.mount('a');
    await act(async () => pane.onDriveMenuOpen?.(click({ left: 10, right: 90, bottom: 30 })));
    expect(h.dialogs.setDriveMenu.mock.calls[0]?.[0]).toMatchObject({ x: 90 });
  });

  test('a second click on the crumb closes the open menu', async () => {
    const h = harness({ driveMenu: { id: 'a' } });
    const pane = h.mount('a');
    await act(async () => pane.onDriveMenuOpen?.(click({})));
    expect(h.dialogs.setDriveMenu).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.drives).not.toHaveBeenCalled();
  });

  test('a server pane has no drive menu', () => {
    expect(harness().mount('b').onDriveMenuOpen).toBeUndefined();
  });
});

describe('the actions a pane passes on unchanged', () => {
  test('file operations keep the pane, the tab and the entry', () => {
    const h = harness({ a: localPane({ selected: new Set(['report.pdf']) }) });
    const pane = h.mount('a');
    const entry = file('report.pdf');
    pane.onRename?.(entry, 'final.pdf');
    pane.onDeleteSelected?.({ permanent: true });
    pane.onDeleteSelected?.();
    h.toolbar().onDelete();
    pane.onNewFolder?.();
    pane.onNewFile?.();
    h.toolbar().onNewFolder();
    h.toolbar().onNewFile();
    expect(h.browser.renamePaneEntry).toHaveBeenCalledWith('a', entry, 'final.pdf');
    expect(h.browser.deletePaneSelected.mock.calls).toEqual([
      ['a', 'tab-1', true],
      ['a', 'tab-1', false],
      ['a'],
    ]);
    expect(h.dialogs.setNewFolderTarget.mock.calls).toEqual([['a'], ['a']]);
    expect(h.dialogs.setNewFileTarget.mock.calls).toEqual([['a'], ['a']]);
  });

  test('navigation, selection and the path bar act on this pane', () => {
    const h = harness();
    const pane = h.mount('b');
    pane.onNavigateBack?.();
    pane.onNavigateForward?.();
    pane.onNavigateUp?.();
    h.toolbar().onBack();
    h.toolbar().onForward();
    h.toolbar().onUp();
    pane.onCrumbClick?.('/deep');
    pane.onPathSubmit?.('typed/path');
    pane.onSelectionChange?.(new Set(['notes.txt']));
    pane.onActivate?.();
    expect(h.browser.goPaneBack.mock.calls).toEqual([['b'], ['b']]);
    expect(h.browser.goPaneForward.mock.calls).toEqual([['b'], ['b']]);
    expect(h.browser.paneParent.mock.calls).toEqual([['b'], ['b']]);
    expect(h.browser.navigatePane.mock.calls).toEqual([
      ['b', '/deep'],
      ['b', '/typed/path'],
    ]);
    expect(h.browser.updatePane).toHaveBeenCalledWith('b', { selected: new Set(['notes.txt']) });
    expect(h.browser.activatePane).toHaveBeenCalledWith('b');
    expect(pane.crumbs).toEqual([{ label: 'root', path: '/' }]);
  });

  test('a local pane chooses its folder, and a disconnected pane offers no file actions', () => {
    const h = harness({ b: serverPane({ status: 'idle' }) });
    h.mount('a');
    h.toolbar().onChooseFolder?.();
    expect(h.browser.chooseLocalDir).toHaveBeenCalledWith('a');
    expect(h.chooseFolder).toHaveBeenCalledOnce();

    const pane = h.mount('b');
    expect(h.toolbar().onChooseFolder).toBeUndefined();
    expect(pane.onNavigateBack).toBeUndefined();
    expect(pane.onNewFolder).toBeUndefined();
    expect(pane.onDropFiles).toBeUndefined();
  });

  test('the connection bar reaches the pane lifecycle and the application dialogs', () => {
    const h = harness({ b: serverPane({ status: 'idle' }) });
    h.mount('b');
    const title = h.title();
    const form = { ...h.browser.panes.b.form, host: 'typed.test' };
    title.onSwitchLocal();
    title.onStartConnect();
    title.onFormChange(form);
    title.onDismissError();
    title.onDisconnect();
    title.onCancelConnect();
    title.onSiteConnect(bookmark);
    title.onSaveSite();
    title.onOpenSiteManager();
    title.onOpenLocalPathManager();
    expect(h.browser.switchPaneToLocal).toHaveBeenCalledWith('b');
    expect(h.browser.startPaneConnect).toHaveBeenCalledWith('b');
    expect(h.browser.setPaneForm).toHaveBeenCalledWith('b', form);
    expect(h.browser.updatePane).toHaveBeenCalledWith('b', { errorMessage: '' });
    expect(h.browser.disconnectPane).toHaveBeenCalledWith('b');
    expect(h.browser.cancelConnectPane).toHaveBeenCalledWith('b');
    expect(h.browser.siteConnectPane).toHaveBeenCalledWith('b', bookmark);
    expect(h.saveSite).toHaveBeenCalledWith('b');
    expect(h.saveNow).toHaveBeenCalledOnce();
    expect(h.dialogs.setShowSiteManagerDialog).toHaveBeenCalledWith('b');
    expect(h.dialogs.setShowLocalPathManagerDialog).toHaveBeenCalledWith('b');
  });

  test('the clipboard and the context menu act on this pane', () => {
    const h = harness();
    const pane = h.mount('b');
    const paneB = h.browser.panes.b;
    pane.onCopySelection?.();
    pane.onCutSelection?.();
    pane.onPaste?.();
    expect(h.clipboard.copyToClipboard).toHaveBeenCalledWith('b', paneB);
    expect(h.clipboard.cutToClipboard).toHaveBeenCalledWith('b', paneB);
    expect(h.clipboard.pasteClipboard).toHaveBeenCalledWith('b', paneB);
    expect(pane.dragMoveStart).toBe(h.clipboard.dragMove.startDrag);
    expect(pane.outboundDragRef).toBe(h.clipboard.outboundDragRef);

    const items = pane.getContextMenuItems?.(null, { permanent: false, folderOrder: [] }) ?? [];
    items.find((item) => item.label === 'paneMenu.refresh')?.onClick?.();
    expect(h.browser.refreshPane).toHaveBeenCalledWith('b', '/deep/inside');
  });
});
