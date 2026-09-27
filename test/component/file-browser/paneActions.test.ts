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
  const options = {
    t: (key: string) => key,
    panes: tab.panes,
    activeTabId: tab.id,
    paneJoin,
    navigatePane: vi.fn(),
    refreshPane: vi.fn(),
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
  };
  return { tab, options, menu: usePaneActions(options).buildPaneMenu };
}
const file: FileEntry = { name: 'file.txt', isDirectory: false, size: 42 };

test('empty-pane actions are disabled for disconnected servers and route to the correct pane', () => {
  const { tab, options, menu } = setup();
  tab.panes.b.status = 'idle';
  expect(menu('b')(null).every((item) => item.disabled)).toBe(true);
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
    menu(id)(file)[0]!.onClick!();
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
    expect(options.refreshPane).toHaveBeenCalledWith(other, tab.panes[other].path);
  },
);

test('remote-to-remote copies are labelled correctly and unavailable transfers are disabled', () => {
  const { tab, options, menu } = setup();
  tab.panes.a.kind = 'remote';
  options.canCopyBetween.mockReturnValue(false);
  const item = menu('b')(file)[0]!;
  expect(item.label).toBe('paneMenu.copyToOtherPane');
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
    const noClipboard = usePaneActions({ ...options, clipboard: null }).buildPaneMenu('a')(file);
    expect(() =>
      noClipboard.find((item) => item.label === 'paneMenu.copyPath')!.onClick!(),
    ).not.toThrow();
  } finally {
    dispose();
  }
});
