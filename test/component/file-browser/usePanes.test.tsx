import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { usePanes } from '../../../src/features/file-browser/usePanes.ts';
import { initialForm, makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
import {
  resetTransfersStoreForTests,
  setTransfersStore,
} from '../../../src/features/transfers/transferStore.ts';
import type { CommandResult } from '../../../src/platform/ipcContracts.ts';
import type { FileEntry } from '../../../src/shared/paneContracts.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function backend() {
  return {
    fsLocal: {
      list: vi.fn(async (path = 'C:\\home') => ({ ok: true, path, entries: [] as FileEntry[] })),
      mkdir: vi.fn().mockResolvedValue({ ok: true }),
      createFile: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      rename: vi.fn().mockResolvedValue({ ok: true }),
      selectDir: vi.fn().mockResolvedValue('C:\\chosen'),
      homedir: vi.fn().mockResolvedValue('C:\\home'),
    },
    session: {
      connect: vi.fn().mockResolvedValue({ ok: true }),
      disconnect: vi.fn().mockResolvedValue({ ok: true }),
      cancelConnect: vi.fn().mockResolvedValue({ ok: true }),
      trustHostKey: vi.fn().mockResolvedValue({ ok: true }),
      list: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
      mkdir: vi.fn().mockResolvedValue({ ok: true }),
      createFile: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      rename: vi.fn().mockResolvedValue({ ok: true }),
    },
    settings: {
      get: vi.fn().mockResolvedValue({ saveSessionOnExit: false }),
      set: vi.fn().mockResolvedValue({ ok: true }),
    },
    tabs: {
      get: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue({ ok: true }),
      set: vi.fn().mockResolvedValue({ ok: true }),
    },
    sites: { list: vi.fn().mockResolvedValue([]) },
    transfer: { onProgress: vi.fn(() => () => {}) },
  };
}
let client: ReturnType<typeof backend>;
beforeEach(() => {
  resetTransfersStoreForTests();
  let nextId = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, '0')}`,
  );
  client = backend();
  window.api = client as unknown as Window['api'];
});
afterEach(resetTransfersStoreForTests);

async function open(overwriteAction: 'ask' | 'skip' | 'overwrite' = 'ask') {
  const options = {
    reportError: vi.fn(),
    setErrorMessage: vi.fn(),
    requestConfirm: vi.fn(),
    connectTimeout: 30,
    paneOrientation: 'horizontal' as const,
    overwriteAction,
    ftpActiveMode: false,
    saveSessionOnExit: false,
    defaultLocalPath: 'C:\\home',
    onVaultUnlockRequired: vi.fn(),
    stopTransfersForConnection: vi.fn().mockResolvedValue(undefined),
  };
  const hook = renderHook(() => usePanes(options));
  await waitFor(() => expect(hook.result.current.panes.a.path).toBe('C:\\home'));
  return { ...hook, options };
}
const file = (name: string, isDirectory = false): FileEntry => ({ name, isDirectory });

test('navigation commits successful history and preserves it when a listing fails', async () => {
  const { result, options } = await open();
  await act(async () => result.current.navigatePane('a', 'C:\\first'));
  await act(async () => result.current.navigatePane('a', 'C:\\second'));
  expect(result.current.panes.a.history).toEqual(['C:\\home', 'C:\\first']);
  await act(async () => result.current.goPaneBack('a'));
  expect(result.current.panes.a.path).toBe('C:\\first');
  expect(result.current.panes.a.future).toEqual(['C:\\second']);
  await act(async () => result.current.goPaneForward('a'));
  expect(result.current.panes.a.path).toBe('C:\\second');
  client.fsLocal.list.mockResolvedValueOnce({ ok: false, path: 'C:\\missing', entries: [] });
  await act(async () => result.current.navigatePane('a', 'C:\\missing'));
  expect(result.current.panes.a.path).toBe('C:\\second');
  expect(result.current.panes.a.history).toEqual(['C:\\home', 'C:\\first']);
  expect(options.reportError).toHaveBeenCalledOnce();
  await act(async () => result.current.paneParent('a'));
  expect(result.current.panes.a.path).toBe('C:\\');
  expect(result.current.crumbsFor(result.current.panes.a)).toEqual([{ label: 'C:', path: 'C:\\' }]);
});

test('rapid directory opens descend from the completed listing instead of its old path', async () => {
  const { result } = await open();
  let finish!: (_value: { ok: boolean; path: string; entries: FileEntry[] }) => void;
  client.fsLocal.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => result.current.openDirectory('a', 'outer'));
  act(() => result.current.openDirectory('a', 'inner'));
  await act(async () => finish({ ok: true, path: 'C:\\home\\outer', entries: [] }));
  expect(result.current.panes.a.path).toBe('C:\\home\\outer\\inner');
});

test('sync browsing mirrors paths inside its anchors and stops when both panes become local', async () => {
  const { result } = await open();
  await act(async () => result.current.connectPane('b', { ...initialForm, host: 'example' })());
  act(() => result.current.toggleSync());
  await act(async () => result.current.navigatePane('a', 'C:\\home\\nested'));
  expect(result.current.panes.b.path).toBe('/nested');
  const calls = client.session.list.mock.calls.length;
  await act(async () => result.current.navigatePane('a', 'D:\\outside'));
  expect(client.session.list).toHaveBeenCalledTimes(calls);
  await act(async () => result.current.switchPaneToLocal('b', undefined, 'D:\\local'));
  expect(result.current.syncBrowsing).toBe(false);
  expect(result.current.syncEligible).toBe(false);
});

test('closing and reopening tabs preserves paths but refreshes their directory contents', async () => {
  const { result } = await open();
  const first = result.current.activeTabId;
  act(() => result.current.closeTab(first));
  expect(result.current.tabs).toHaveLength(1);
  await act(async () => result.current.openNewTab());
  const second = result.current.activeTabId;
  await act(async () => result.current.navigatePane('a', 'C:\\work'));
  act(() => result.current.closeTab(second));
  expect(result.current.activeTabId).toBe(first);
  expect(result.current.canReopenClosedTab).toBe(true);
  await act(async () => result.current.reopenClosedTab());
  expect(result.current.tabs).toHaveLength(2);
  expect(result.current.activeTabId).not.toBe(second);
  expect(result.current.panes.a.path).toBe('C:\\work');
  expect(result.current.canReopenClosedTab).toBe(false);
});

test('closing an active transfer tab waits for confirmation and settles work before disconnecting', async () => {
  const { result, options } = await open();
  await act(async () => result.current.openNewTab());
  await act(async () => result.current.connectPane('b', { ...initialForm, host: 'server' })());
  const connectionId = result.current.panes.b.connectionId!;
  setTransfersStore({
    upload: {
      id: 'upload',
      name: 'a.txt',
      status: 'progress',
      bytes: 0,
      startedAt: 0,
      direction: 'up',
      protocol: 'ftp',
      connectionId,
      localFile: 'C:\\a.txt',
      remoteTarget: '/a.txt',
    },
  });
  act(() => result.current.closeTab(result.current.activeTabId));
  expect(result.current.tabs).toHaveLength(2);
  expect(client.session.disconnect).not.toHaveBeenCalled();
  let settled!: () => void;
  options.stopTransfersForConnection.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settled = resolve;
      }),
  );
  act(() => options.requestConfirm.mock.calls[0]![1]());
  expect(result.current.tabs).toHaveLength(1);
  expect(options.stopTransfersForConnection).toHaveBeenCalledWith(connectionId);
  expect(client.session.disconnect).not.toHaveBeenCalled();
  await act(async () => settled());
  expect(client.session.disconnect).toHaveBeenCalledWith(connectionId);
  await act(async () => result.current.reopenClosedTab());
  expect(result.current.panes.b.status).toBe('connected');
  expect(result.current.panes.b.connectionId).not.toBe(connectionId);
});

test.each(['ftp', 'ftps', 'sftp', 'webdav'] as const)(
  '%s becomes connected only after its first listing succeeds',
  async (protocol) => {
    const { result } = await open();
    await act(async () =>
      result.current.connectPane('b', {
        ...initialForm,
        protocol,
        host: 'example',
        port: '22',
        webdavUrl: 'https://example/dav',
      })(),
    );
    expect(result.current.panes.b.status).toBe('connected');
    expect(client.session.connect).toHaveBeenCalledWith(
      result.current.panes.b.connectionId,
      expect.objectContaining({
        kind: 'direct',
        server: expect.objectContaining({ protocol, port: 22 }),
      }),
      expect.anything(),
    );
    expect(result.current.canCopyBetween(result.current.panes.a, result.current.panes.b)).toBe(
      true,
    );
    await act(async () => result.current.disconnectPane('b'));
    expect(result.current.panes.b.status).toBe('idle');
    expect(result.current.canCopyBetween(result.current.panes.a, result.current.panes.b)).toBe(
      false,
    );
    expect(result.current.canCopyBetween(result.current.panes.b, result.current.panes.a)).toBe(
      false,
    );
  },
);

test.each(['example/dav', 'file:///C:/dav'])(
  'invalid WebDAV URL %s never opens a session',
  async (webdavUrl) => {
    const { result } = await open();
    await act(async () =>
      result.current.connectPane('b', { ...initialForm, protocol: 'webdav', webdavUrl })(),
    );
    expect(client.session.connect).not.toHaveBeenCalled();
    expect(result.current.panes.b.status).toBe('error');
  },
);

test('failed initial listing closes the half-open connection and leaves no usable remote pane', async () => {
  const { result } = await open();
  client.session.list.mockResolvedValueOnce({
    ok: false,
    errorCode: 'permissionDenied',
    error: 'Denied',
    entries: [],
  });
  await act(async () => result.current.connectPane('b', { ...initialForm, host: 'example' })());
  expect(result.current.panes.b.status).toBe('error');
  expect(client.session.disconnect).toHaveBeenCalledWith(result.current.panes.b.connectionId);
});

test('cancelling an in-flight connection discards and disconnects its late successful reply', async () => {
  const { result } = await open();
  let finish!: (_value: CommandResult) => void;
  client.session.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.connectPane('b', { ...initialForm, host: 'example' })();
  });
  const id = result.current.panes.b.connectionId;
  act(() => result.current.cancelConnectPane('b'));
  await act(async () => {
    finish({ ok: true });
    await pending;
  });
  expect(result.current.panes.b.status).toBe('idle');
  expect(client.session.cancelConnect).toHaveBeenCalledWith(id);
  expect(client.session.disconnect).toHaveBeenCalledWith(id);
  expect(client.session.list).not.toHaveBeenCalled();
});

test('a locked vault offers a retry that reconnects the same bookmark and folder', async () => {
  const { result, options } = await open();
  client.session.connect.mockResolvedValueOnce({ ok: false, errorCode: 'vaultLocked' });
  await act(async () =>
    result.current.connectSavedSite({
      id: 'saved',
      name: 'Server',
      host: 'example',
      remotePath: '/saved',
    }),
  );
  expect(result.current.panes.b.status).toBe('idle');
  expect(options.onVaultUnlockRequired).toHaveBeenCalledOnce();
  await act(async () => options.onVaultUnlockRequired.mock.calls[0]![0]());
  expect(result.current.panes.b.path).toBe('/saved');
  expect(result.current.recentSiteIds).toEqual(['saved']);
  expect(client.session.connect).toHaveBeenLastCalledWith(
    expect.any(String),
    { kind: 'savedSite', siteId: 'saved' },
    expect.anything(),
  );
  act(() => result.current.setPaneForm('b', { ...initialForm, host: 'manual' }));
  expect(result.current.panes.b.siteId).toBeNull();
  expect(result.current.panes.b.siteLabel).toBe('');
});

test('replacing a connected bookmark asks before disconnecting; local bookmarks preserve Back', async () => {
  const { result, options } = await open();
  await act(async () => result.current.connectSavedSite({ id: 'one', name: 'One', host: 'one' }));
  act(() => result.current.connectSavedSite({ id: 'two', name: 'Two', host: 'two' }));
  expect(client.session.connect).toHaveBeenCalledOnce();
  await act(async () => options.requestConfirm.mock.calls[0]![1]());
  expect(result.current.panes.b.siteId).toBe('two');
  await act(async () =>
    result.current.connectSavedSite({
      id: 'local',
      kind: 'local',
      name: 'Work',
      localPath: 'C:\\work',
    }),
  );
  expect(result.current.panes.a.path).toBe('C:\\work');
  expect(result.current.panes.a.history).toEqual(['C:\\home']);
});

test.each(['ask', 'skip', 'overwrite'] as const)(
  'local overwrite policy %s handles case-insensitive collisions without losing new files',
  async (policy) => {
    const { result, options } = await open(policy);
    const target = { ...result.current.panes.a, entries: [file('EXISTS.txt')] };
    const proceed = vi.fn();
    await act(async () =>
      result.current.confirmOverwriteIfNeeded(
        target,
        undefined,
        ['exists.txt', 'new.txt'],
        proceed,
      ),
    );
    if (policy === 'ask') {
      expect(proceed).not.toHaveBeenCalled();
      act(() => options.requestConfirm.mock.calls[0]![1]());
      expect(proceed).toHaveBeenCalledWith(['exists.txt', 'new.txt'], true);
    } else if (policy === 'skip') expect(proceed).toHaveBeenCalledWith(['new.txt'], false);
    else expect(proceed).toHaveBeenCalledWith(['exists.txt', 'new.txt'], true);
  },
);

test('skip-all conflicts and destination listing failures never start a transfer', async () => {
  const { result, options } = await open('skip');
  const target = { ...result.current.panes.a, entries: [file('exists')] };
  const proceed = vi.fn();
  await act(async () =>
    result.current.confirmOverwriteIfNeeded(target, undefined, ['exists'], proceed),
  );
  client.fsLocal.list.mockResolvedValueOnce({ ok: false, path: '', entries: [] });
  await act(async () => result.current.confirmOverwriteIfNeeded(target, 'sub', ['new'], proceed));
  expect(proceed).not.toHaveBeenCalled();
  expect(options.reportError).toHaveBeenCalledOnce();
});

test('remote names are case-sensitive and directory merges do not ask to replace a file', async () => {
  const { result, options } = await open();
  const target = { ...makePane('b', 'remote'), entries: [file('EXISTS'), file('folder', true)] };
  const proceed = vi.fn();
  await act(async () =>
    result.current.confirmOverwriteIfNeeded(target, undefined, ['exists', 'folder'], proceed, [
      file('exists'),
      file('folder', true),
    ]),
  );
  expect(proceed).toHaveBeenCalledWith(['exists', 'folder'], false);
  expect(options.requestConfirm).not.toHaveBeenCalled();
});

test('delete confirmation filters stale selections, preserves recycle policy and reports failures', async () => {
  const { result, options } = await open();
  act(() =>
    result.current.updatePane('a', {
      entries: [file('present')],
      selected: new Set(['present', 'stale']),
    }),
  );
  act(() => result.current.deletePaneSelected('a'));
  expect(client.fsLocal.delete).not.toHaveBeenCalled();
  client.fsLocal.delete.mockResolvedValueOnce({ ok: false, errorCode: 'permissionDenied' });
  await act(async () => options.requestConfirm.mock.calls[0]![1]());
  expect(client.fsLocal.delete).toHaveBeenCalledExactlyOnceWith('C:\\home\\present', false);
  expect(options.reportError).toHaveBeenCalledOnce();
  act(() => result.current.deletePaneEntry('a', file('permanent'), undefined, true));
  await act(async () => options.requestConfirm.mock.calls[1]![1]());
  expect(client.fsLocal.delete).toHaveBeenLastCalledWith('C:\\home\\permanent', true);
});

test('create, rename and move operations refresh the pane and never assume overwrite approval', async () => {
  const { result } = await open();
  const tab = result.current.activeTabId;
  await act(async () => result.current.submitNewFolder('folder', tab, 'a'));
  await act(async () => result.current.submitNewFile('new.txt', tab, 'a'));
  await act(async () => result.current.renamePaneEntry('a', file('old.txt'), 'new.txt'));
  await act(async () => result.current.movePaneSamePane('a', ['new.txt'], 'folder'));
  expect(client.fsLocal.mkdir).toHaveBeenCalledWith('C:\\home\\folder');
  expect(client.fsLocal.createFile).toHaveBeenCalledWith('C:\\home\\new.txt');
  expect(client.fsLocal.rename).toHaveBeenNthCalledWith(
    1,
    'C:\\home\\old.txt',
    'C:\\home\\new.txt',
    false,
  );
  expect(client.fsLocal.rename).toHaveBeenNthCalledWith(
    2,
    'C:\\home\\new.txt',
    'C:\\home\\folder\\new.txt',
    false,
  );
  await act(async () => result.current.chooseLocalDir('a')());
  expect(result.current.panes.a.path).toBe('C:\\chosen');
  await act(async () => result.current.goPaneHome('a')());
  expect(result.current.panes.a.path).toBe('C:\\home');
});

test('remote create refuses a visible collision and rename retries only after overwrite confirmation', async () => {
  const { result, options } = await open();
  await act(async () => result.current.connectPane('b', { ...initialForm, host: 'example' })());
  const id = result.current.panes.b.connectionId;
  act(() => result.current.updatePane('b', { entries: [file('exists')] }));
  await act(async () => result.current.submitNewFile('exists', result.current.activeTabId, 'b'));
  expect(client.session.createFile).not.toHaveBeenCalled();
  expect(options.reportError).toHaveBeenCalledOnce();
  client.session.rename.mockResolvedValueOnce({ ok: false, errorCode: 'alreadyExists' });
  await act(async () => result.current.renamePaneEntry('b', file('old'), 'exists'));
  expect(client.session.rename).toHaveBeenCalledExactlyOnceWith(id, '/old', '/exists', false);
  await act(async () => options.requestConfirm.mock.calls[0]![1]());
  expect(client.session.rename).toHaveBeenLastCalledWith(id, '/old', '/exists', true);
});
