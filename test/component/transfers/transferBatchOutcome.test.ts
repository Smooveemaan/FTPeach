import { afterEach, expect, test, vi } from 'vitest';
import { createTransferRouting } from '../../../src/features/transfers/createTransferRouting.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';

const previous = window.api;
afterEach(() => {
  window.api = previous;
});

const localPane = (names: string[]) => ({
  ...makePane('a', 'local'),
  path: 'C:\\work',
  entries: names.map((name) => ({ name, isDirectory: false, size: 1 })),
});

const remotePane = () => ({
  ...makePane('b', 'remote'),
  status: 'connected' as const,
  path: '/upload',
  connectionId: 'session',
  protocol: 'sftp' as const,
});

test('a selection reports what each file did, not just that it finished', async () => {
  window.api = tauriApi;
  const runUpload = vi.fn(async (_id, _protocol, source: string) => ({
    ok: !source.endsWith('refused.txt'),
  }));
  const setError = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload, runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(false),
    'ask',
    setError,
  );

  // "gone.txt" is in the selection but no longer in the listing: it is skipped,
  // and a skip is not a transfer that happened.
  const result = await routing.copyEntries({
    sourcePane: localPane(['sent.txt', 'refused.txt']),
    targetPane: remotePane(),
    names: ['sent.txt', 'refused.txt', 'gone.txt'],
    move: false,
  });

  expect(result.items).toEqual([
    { name: 'sent.txt', outcome: 'copied', sourceRetained: false },
    { name: 'refused.txt', outcome: 'failed', sourceRetained: false },
    { name: 'gone.txt', outcome: 'skipped', sourceRetained: false },
  ]);
  expect(result).toMatchObject({ ok: false, copied: 1, failed: 1, skipped: 1 });
  expect(setError).toHaveBeenCalledTimes(1);
  expect(setError).toHaveBeenCalledWith('1 of 3 items were not transferred.');
});

test('a transfer the user paused, stopped or skipped is not reported as failed', async () => {
  window.api = tauriApi;
  const runUpload = vi.fn(async (_id, _protocol, source: string) =>
    source.endsWith('paused.txt')
      ? { ok: false, errorCode: 'cancelled' as const, cancelled: true }
      : source.endsWith('queued.txt')
        ? { ok: false, alreadyRunning: true }
        : { ok: false, skipped: true },
  );
  const setError = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload, runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(false),
    'ask',
    setError,
  );

  const result = await routing.copyEntries({
    sourcePane: localPane(['paused.txt', 'queued.txt', 'kept.txt']),
    targetPane: remotePane(),
    names: ['paused.txt', 'queued.txt', 'kept.txt'],
    move: false,
  });

  expect(result).toMatchObject({ ok: true, failed: 0, skipped: 3 });
  expect(setError).not.toHaveBeenCalled();
});

test('a folder walk counts as skipped only when the user ended it', async () => {
  window.api = tauriApi;
  const walk = { ok: false, outcome: 'failed' as const, scanned: 2, completed: 0, errors: [] };
  const endings = {
    '/upload/paused': { ...walk, cancelled: true },
    // `skipped` counts files inside the walk; a walk that failed still failed.
    '/upload/broken': { ...walk, skipped: 2, cancelled: false },
  };
  const runRecursive = vi.fn(
    async (intent: { target: { path: string } }) =>
      endings[intent.target.path as keyof typeof endings],
  );
  const routing = createTransferRouting(
    { runRecursive, runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(false),
    'ask',
    vi.fn(),
  );

  const result = await routing.copyEntries({
    sourcePane: {
      ...localPane([]),
      entries: ['paused', 'broken'].map((name) => ({ name, isDirectory: true, size: 0 })),
    },
    targetPane: remotePane(),
    names: ['paused', 'broken'],
    move: false,
  });

  expect(result.items.map((item) => item.outcome)).toEqual(['skipped', 'failed']);
});

test('a move that was refused says the originals are still in place', async () => {
  const rename = vi.fn(async (source: string) =>
    source.endsWith('locked.txt') ? { ok: false, error: 'Access is denied' } : { ok: true },
  );
  window.api = { ...tauriApi, fsLocal: { ...tauriApi.fsLocal, rename } };
  const setError = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(true),
    'ask',
    setError,
  );

  const result = await routing.copyEntries({
    sourcePane: localPane(['moved.txt', 'locked.txt']),
    targetPane: { ...makePane('b', 'local'), path: 'C:\\target' },
    names: ['moved.txt', 'locked.txt'],
    move: true,
    overwriteApproved: true,
  });

  expect(result).toMatchObject({ ok: false, moved: 1, failed: 1, sourceRetained: true });
  expect(result.items[1]).toMatchObject({ name: 'locked.txt', sourceRetained: true });
  expect(setError).toHaveBeenCalledWith(
    expect.stringContaining('The originals are still in place.'),
  );
  expect(setError).toHaveBeenCalledWith(expect.stringContaining('Access is denied'));
});

test('declining the overwrite question is a skip, not a failure', async () => {
  window.api = tauriApi;
  const setError = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    // The user closed the question instead of answering it.
    vi.fn().mockResolvedValue(null),
    'ask',
    setError,
  );

  const result = await routing.copyEntries({
    sourcePane: localPane(['one.txt']),
    targetPane: { ...makePane('b', 'local'), path: 'C:\\target' },
    names: ['one.txt'],
    move: true,
  });

  expect(result).toMatchObject({ ok: true, skipped: 1, moved: 0, sourceRetained: true });
  expect(setError).not.toHaveBeenCalled();
});

test('a Move between endpoints is refused as a whole and keeps its sources', async () => {
  window.api = tauriApi;
  const setError = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(true),
    'ask',
    setError,
  );

  const result = await routing.copyEntries({
    sourcePane: localPane(['one.txt']),
    targetPane: remotePane(),
    names: ['one.txt'],
    move: true,
  });

  expect(result).toMatchObject({ ok: false, sourceRetained: true, items: [] });
  expect(setError).toHaveBeenCalledWith(expect.stringContaining('moved only'));
});
