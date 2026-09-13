import { afterEach, expect, test, vi } from 'vitest';
import { createTransferRouting } from '../../../src/features/transfers/createTransferRouting.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
const previous = window.api;
afterEach(() => {
  window.api = previous;
});

test('local file Move to an absolute breadcrumb uses rename and never copy/delete, including on failure', async () => {
  const rename = vi.fn().mockResolvedValue({ ok: false, error: 'Move denied' });
  const copyFile = vi.fn();
  const remove = vi.fn();
  window.api = { ...tauriApi, fsLocal: { ...tauriApi.fsLocal, rename, copyFile, delete: remove } };
  const setError = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(false),
    'ask',
    setError,
  );
  const source = {
    ...makePane('a', 'local'),
    path: 'C:\\parent\\child',
    entries: [{ name: 'file.txt', isDirectory: false, size: 1 }],
  };
  const refreshSource = vi.fn();
  const refreshTarget = vi.fn();
  await routing.copyEntries({
    sourcePane: source,
    targetPane: source,
    targetFolder: 'C:\\parent',
    names: ['file.txt'],
    move: true,
    refreshSource,
    refreshTarget,
  });
  expect(rename).toHaveBeenCalledWith('C:\\parent\\child\\file.txt', 'C:\\parent\\file.txt', false);
  expect(copyFile).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(setError).toHaveBeenCalled();
  expect(refreshSource).toHaveBeenCalled();
  expect(refreshTarget).toHaveBeenCalled();
});

test('folder Copy to a remote breadcrumb preserves the absolute endpoint and copy intent', async () => {
  window.api = tauriApi;
  const runRecursive = vi.fn().mockResolvedValue({ ok: true });
  const routing = createTransferRouting(
    { runRecursive, runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(false),
    'ask',
    vi.fn(),
  );
  const source = {
    ...makePane('a', 'local'),
    path: 'C:\\work',
    entries: [{ name: 'folder', isDirectory: true, size: 0 }],
  };
  const target = {
    ...makePane('b', 'remote'),
    status: 'connected' as const,
    path: '/parent/child',
    connectionId: 'session',
  };
  await routing.copyEntries({
    sourcePane: source,
    targetPane: target,
    targetFolder: '/parent',
    names: ['folder'],
    move: false,
  });
  expect(runRecursive).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { kind: 'remote', path: '/parent/folder', connectionId: 'session' },
      moving: false,
    }),
    undefined,
    undefined,
    undefined,
    undefined,
  );
});
