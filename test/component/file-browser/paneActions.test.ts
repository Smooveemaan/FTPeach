import { expect, test, vi } from 'vitest';
import { usePaneActions } from '../../../src/features/file-browser/usePaneActions.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { paneJoin } from '../../../src/features/file-browser/panes/paneBackend.ts';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';
import type { FileEntry } from '../../../src/shared/paneContracts.ts';

function setup() {
  const tab = makeTab('tab');
  tab.panes.a.path = 'C:\\source';
  tab.panes.b.path = '/target';
  tab.panes.b.connectionId = 'session';
  tab.panes.b.status = 'connected';
  const options = mocks(tab);
  return { tab, options, menu: actions(options).buildPaneMenu };
}

function mocks(tab: ReturnType<typeof makeTab>) {
  return {
    t: (key: string) => key,
    panes: tab.panes,
    activeTabId: tab.id,
    paneJoin,
    navigatePane: vi.fn(),
    refreshPane: vi.fn(),
    refreshPaneIfAt: vi.fn(),
    canCopyBetween: vi.fn(() => true),
    confirmOverwriteIfNeeded: vi.fn(),
    copyEntries: vi.fn(),
    deletePaneSelected: vi.fn(),
    deletePaneEntry: vi.fn(),
    setNewFolderTarget: vi.fn(),
    setNewFileTarget: vi.fn(),
    setMoveToTarget: vi.fn(),
    setChmodTarget: vi.fn(),
    setOpenWithTarget: vi.fn(),
    selectApplication: vi.fn().mockResolvedValue('C:/Apps/editor.exe'),
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    fileClipboard: {
      copyToClipboard: vi.fn(),
      cutToClipboard: vi.fn(),
      canPaste: vi.fn(() => true),
      pasteClipboard: vi.fn(),
    },
  };
}

// The flat mocks above, handed over the way FileBrowserPane hands them.
function actions(
  options: ReturnType<typeof mocks>,
  clipboard: Pick<Clipboard, 'writeText'> | null = options.clipboard,
) {
  return usePaneActions({
    t: options.t,
    browser: {
      panes: options.panes,
      activeTabId: options.activeTabId,
      paneJoin: options.paneJoin,
      navigatePane: options.navigatePane,
      refreshPane: options.refreshPane,
      refreshPaneIfAt: options.refreshPaneIfAt,
      canCopyBetween: options.canCopyBetween,
      confirmOverwriteIfNeeded: options.confirmOverwriteIfNeeded,
      deletePaneSelected: options.deletePaneSelected,
      deletePaneEntry: options.deletePaneEntry,
      connectPane: vi.fn(),
      siteConnectPane: vi.fn(),
      goPaneHome: vi.fn(),
    },
    sites: [],
    shell: {
      dialogs: {
        setNewFolderTarget: options.setNewFolderTarget,
        setNewFileTarget: options.setNewFileTarget,
        setMoveToTarget: options.setMoveToTarget,
        setChmodTarget: options.setChmodTarget,
        setShowSiteManagerDialog: vi.fn(),
        setShowLocalPathManagerDialog: vi.fn(),
        driveMenu: null,
        setDriveMenu: vi.fn(),
      },
      transfers: { copyEntries: options.copyEntries, handleOsDropFiles: vi.fn() },
      openWith: { setTarget: options.setOpenWithTarget },
      reportError: vi.fn(),
    },
    selectApplication: options.selectApplication,
    clipboard,
    fileClipboard: options.fileClipboard,
  });
}
const file: FileEntry = { name: 'file.txt', isDirectory: false, size: 42 };
/** The menu as its labels, with `-` for a separator. */
const shape = (items: { label?: string; separator?: boolean }[]) =>
  items.map((item) => (item.separator ? '-' : item.label));

test('the menus follow the order of the Explorer menu', () => {
  const { tab, menu } = setup();
  tab.panes.b.form.protocol = 'sftp';
  const rename = () => {};
  expect(shape(menu('b')(file, { rename }))).toEqual([
    'paneMenu.open',
    'paneMenu.openWith',
    '-',
    'paneMenu.downloadToOtherPane',
    'paneMenu.moveTo',
    '-',
    'settings.shortcuts.actions.cut',
    'settings.shortcuts.actions.copy',
    'paneMenu.copyPath',
    '-',
    'paneMenu.delete',
    'filePane.rename',
    '-',
    'paneMenu.refresh',
    '-',
    'paneMenu.permissions',
  ]);
  expect(shape(menu('a')({ name: 'folder', isDirectory: true }, { rename }))).toEqual([
    'paneMenu.open',
    '-',
    'paneMenu.uploadToOtherPane',
    'paneMenu.moveTo',
    '-',
    'settings.shortcuts.actions.cut',
    'settings.shortcuts.actions.copy',
    'paneMenu.copyPath',
    '-',
    'paneMenu.delete',
    'filePane.rename',
    '-',
    'paneMenu.refresh',
  ]);
  // A pane that cannot rename gets no Rename.
  expect(shape(menu('a')(file))).toEqual([
    'paneMenu.open',
    '-',
    'paneMenu.uploadToOtherPane',
    'paneMenu.moveTo',
    '-',
    'settings.shortcuts.actions.cut',
    'settings.shortcuts.actions.copy',
    'paneMenu.copyPath',
    '-',
    'paneMenu.delete',
    '-',
    'paneMenu.refresh',
  ]);
  expect(shape(menu('a')(null))).toEqual([
    'paneMenu.refresh',
    '-',
    'settings.shortcuts.actions.paste',
    '-',
    'paneMenu.newFolder',
    'paneMenu.newFile',
  ]);
});

test('Cut and Copy hold the clicked entry, or the selection it belongs to', () => {
  const { tab, options, menu } = setup();
  const { copyToClipboard, cutToClipboard } = options.fileClipboard;
  const pick = (items: ReturnType<ReturnType<typeof menu>>, action: 'cut' | 'copy') =>
    items.find((item) => item.label === `settings.shortcuts.actions.${action}`)!;
  // Another row is selected: the menu acts on the one under the pointer.
  tab.panes.a.selected = new Set(['another.txt']);
  const single = menu('a')(file);
  expect(pick(single, 'copy').shortcut).toBe('Ctrl+C');
  expect(pick(single, 'cut').shortcut).toBe('Ctrl+X');
  pick(single, 'copy').onClick!();
  expect(copyToClipboard).toHaveBeenCalledWith(
    'a',
    expect.objectContaining({ path: 'C:\\source', selected: new Set(['file.txt']) }),
  );
  tab.panes.a.selected = new Set(['file.txt', 'another.txt']);
  pick(menu('a')(file), 'cut').onClick!();
  expect(cutToClipboard).toHaveBeenCalledWith(
    'a',
    expect.objectContaining({ selected: new Set(['file.txt', 'another.txt']) }),
  );
});

test('Paste in the empty-space menu pastes into the pane, when there is something to paste', () => {
  const { tab, options, menu } = setup();
  const paste = () =>
    menu('b')(null).find((item) => item.label === 'settings.shortcuts.actions.paste')!;
  expect(paste().shortcut).toBe('Ctrl+V');
  expect(paste().disabled).toBe(false);
  paste().onClick!();
  expect(options.fileClipboard.pasteClipboard).toHaveBeenCalledWith('b', tab.panes.b);
  options.fileClipboard.canPaste.mockReturnValue(false);
  expect(paste().disabled).toBe(true);
});

test('a folder, and a whole selection, can be sent to the other pane from the menu', () => {
  const { tab, options, menu } = setup();
  const folder: FileEntry = { name: 'folder', isDirectory: true };
  tab.panes.a.entries = [file, folder, { name: 'other.txt', isDirectory: false }];
  const send = (entry: FileEntry) =>
    menu('a')(entry).find((item) => item.label === 'paneMenu.uploadToOtherPane')!;
  send(folder).onClick!();
  expect(options.confirmOverwriteIfNeeded.mock.calls[0]![2]).toEqual(['folder']);
  expect(options.confirmOverwriteIfNeeded.mock.calls[0]![4]).toEqual([folder]);
  tab.panes.a.selected = new Set(['file.txt', 'folder']);
  send(file).onClick!();
  expect(options.confirmOverwriteIfNeeded.mock.calls[1]![2]).toEqual(['file.txt', 'folder']);
  expect(options.confirmOverwriteIfNeeded.mock.calls[1]![4]).toEqual([file, folder]);
});

test('Open on a file of this computer opens it as a double click does', async () => {
  const { menu } = setup();
  const openPath = vi.fn(async () => ({ ok: true }));
  window.api = { fsLocal: { openPath } } as unknown as Window['api'];
  menu('a')(file).find((item) => item.label === 'paneMenu.open')!.onClick!();
  await vi.waitFor(() => expect(openPath).toHaveBeenCalledWith('C:\\source\\file.txt'));
});

test('Rename in the menu starts the rename the pane handed over', () => {
  const { menu } = setup();
  const rename = vi.fn();
  const item = menu('a')(file, { rename }).find((entry) => entry.label === 'filePane.rename')!;
  expect(item.shortcut).toBe('F2');
  item.onClick!();
  expect(rename).toHaveBeenCalledOnce();
});

test('empty-pane actions are disabled for disconnected servers and route to the correct pane', () => {
  const { tab, options, menu } = setup();
  tab.panes.b.status = 'idle';
  expect(menu('b')(null).every((item) => item.separator || item.disabled)).toBe(true);
  const items = menu('a')(null);
  for (const item of items) item.onClick?.();
  expect(options.setNewFolderTarget).toHaveBeenCalledWith('a');
  expect(options.setNewFileTarget).toHaveBeenCalledWith('a');
  expect(options.refreshPane).toHaveBeenCalledWith('a', 'C:\\source');
});

test.each(['a', 'b'] as const)(
  'copy from pane %s waits for conflict approval and passes the decision downstream',
  (id) => {
    const { options, menu, tab } = setup();
    const label = id === 'a' ? 'paneMenu.uploadToOtherPane' : 'paneMenu.downloadToOtherPane';
    menu(id)(file).find((item) => item.label === label)!.onClick!();
    expect(options.copyEntries).not.toHaveBeenCalled();
    const call = options.confirmOverwriteIfNeeded.mock.calls[0]!;
    expect(call[2]).toEqual(['file.txt']);
    expect(call[4]).toEqual([file]);
    call[3](['file.txt'], true);
    const other = id === 'a' ? 'b' : 'a';
    expect(options.copyEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePane: tab.panes[id],
        targetPane: tab.panes[other],
        names: ['file.txt'],
        overwriteApproved: true,
        move: false,
      }),
    );
    options.copyEntries.mock.calls[0]![0].refreshTarget();
    expect(options.refreshPaneIfAt).toHaveBeenCalledWith(other, tab.panes[other].path);
  },
);

test('remote-to-remote copies are labelled correctly and unavailable transfers are disabled', () => {
  const { tab, options, menu } = setup();
  tab.panes.a.kind = 'remote';
  options.canCopyBetween.mockReturnValue(false);
  const item = menu('b')(file).find((entry) => entry.label === 'paneMenu.copyToOtherPane')!;
  expect(item.disabled).toBe(true);
});

test.each([false, true])(
  'deletion targets the selection only if the clicked entry belongs to it (permanent: %s)',
  (permanent) => {
    const { tab, options, menu } = setup();
    tab.panes.a.selected = new Set(['file.txt', 'another.txt']);
    const items = menu('a')(file, { permanent });
    items.find((item) => item.danger)!.onClick!();
    expect(options.deletePaneSelected).toHaveBeenCalledWith('a', 'tab', permanent);
    expect(options.deletePaneEntry).not.toHaveBeenCalled();
    const outside = { ...file, name: 'outside.txt' };
    menu('a')(outside, { permanent }).find((item) => item.danger)!.onClick!();
    expect(options.deletePaneEntry).toHaveBeenCalledWith('a', outside, 'tab', permanent);
  },
);

test('move destinations preserve display order and exclude selected folders', () => {
  const { tab, options, menu } = setup();
  const directory = { name: 'selected-folder', isDirectory: true };
  tab.panes.a.selected = new Set(['file.txt', 'selected-folder']);
  const items = menu('a')(directory, { folderOrder: ['z', 'selected-folder', 'a'] });
  items.find((item) => item.label === 'paneMenu.moveTo')!.onClick!();
  expect(options.setMoveToTarget).toHaveBeenCalledWith({
    id: 'a',
    names: ['file.txt', 'selected-folder'],
    folders: ['z', 'a'],
  });
  items.find((item) => item.label === 'paneMenu.open')!.onClick!();
  expect(options.navigatePane).toHaveBeenCalledWith('a', 'C:\\source\\selected-folder');
  expect(menu('a')(directory).find((item) => item.label === 'paneMenu.moveTo')!.disabled).toBe(
    true,
  );
});

test('SFTP permissions and open-with retain the entry and its original session', async () => {
  const { tab, options, menu } = setup();
  tab.panes.b.form.protocol = 'sftp';
  const entry = { ...file, permissions: 'rwxr-x---' };
  const items = menu('b')(entry);
  items.find((item) => item.label === 'paneMenu.permissions')!.onClick!();
  expect(options.setChmodTarget).toHaveBeenCalledWith({ id: 'b', entry, mode: '750' });
  items.find((item) => item.label === 'paneMenu.openWith')!.onClick!();
  await vi.waitFor(() => expect(options.setOpenWithTarget).toHaveBeenCalled());
  expect(options.setOpenWithTarget).toHaveBeenCalledWith({
    path: '/target/file.txt',
    application: 'C:/Apps/editor.exe',
    size: 42,
    connectionId: 'session',
    paneId: 'b',
    tabId: 'tab',
  });
  tab.panes.b.connectionId = null;
  const disconnected = menu('b')(entry).find((item) => item.label === 'paneMenu.openWith')!;
  expect(disconnected.disabled).toBe(true);
  disconnected.onClick!();
  expect(options.setOpenWithTarget).toHaveBeenCalledOnce();
});

test('Open on a remote file opens it with the default program, without asking', () => {
  const { options, menu } = setup();
  const items = menu('b')(file);
  const labels = items.map((item) => item.label);
  expect(labels.indexOf('paneMenu.open')).toBe(labels.indexOf('paneMenu.openWith') - 1);
  items.find((item) => item.label === 'paneMenu.open')!.onClick!();
  expect(options.selectApplication).not.toHaveBeenCalled();
  expect(options.setOpenWithTarget).toHaveBeenCalledWith({
    path: '/target/file.txt',
    size: 42,
    connectionId: 'session',
    paneId: 'b',
    tabId: 'tab',
  });
});

test('open-with opens nothing when choosing the program is cancelled', async () => {
  const { options, menu } = setup();
  options.selectApplication.mockResolvedValue(null);
  menu('b')(file).find((item) => item.label === 'paneMenu.openWith')!.onClick!();
  await vi.waitFor(() => expect(options.selectApplication).toHaveBeenCalled());
  await Promise.resolve();
  expect(options.setOpenWithTarget).not.toHaveBeenCalled();
});

test('clipboard failures are reported and a missing clipboard leaves the menu usable', async () => {
  const { options, menu } = setup();
  const failure = new Error('clipboard denied');
  const sink = vi.fn();
  const dispose = setAsyncFailureSink(sink);
  try {
    options.clipboard.writeText.mockRejectedValueOnce(failure);
    await menu('a')(file).find((item) => item.label === 'paneMenu.copyPath')!.onClick!();
    expect(options.clipboard.writeText).toHaveBeenCalledWith('C:\\source\\file.txt');
    expect(sink).toHaveBeenCalledWith(failure);
    const noClipboard = actions(options, null).buildPaneMenu('a')(file);
    expect(() =>
      noClipboard.find((item) => item.label === 'paneMenu.copyPath')!.onClick!(),
    ).not.toThrow();
  } finally {
    dispose();
  }
});
