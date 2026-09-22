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

test('a large selection is admitted in bounded batches instead of all at once', async () => {
  window.api = tauriApi;
  let active = 0;
  let peak = 0;
  const runUpload = vi.fn(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return { ok: true };
  });
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload, runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(false),
    'ask',
    vi.fn(),
  );
  const names = Array.from({ length: 500 }, (_, index) => `file-${index}.txt`);

  await routing.copyEntries({
    sourcePane: localPane(names),
    targetPane: remotePane(),
    names,
    move: false,
  });

  expect(runUpload).toHaveBeenCalledTimes(500);
  expect(peak).toBeLessThanOrEqual(64);
});

test('a failed copy does not end the batch while another copy is still running', async () => {
  let releaseSecond = () => {};
  const held = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let secondFinished = false;
  const copyFile = vi.fn(async (source: string) => {
    if (source.endsWith('first.txt')) return { ok: false, error: 'Copy denied' };
    await held;
    secondFinished = true;
    return { ok: true };
  });
  window.api = {
    ...tauriApi,
    fsLocal: {
      ...tauriApi.fsLocal,
      copyFile,
      validateCopy: async () => ({ ok: true }),
    },
  };
  const setError = vi.fn();
  const refreshTarget = vi.fn();
  const routing = createTransferRouting(
    { runRecursive: vi.fn(), runUpload: vi.fn(), runDownload: vi.fn(), runRemoteCopy: vi.fn() },
    vi.fn().mockResolvedValue(true),
    'ask',
    setError,
  );

  const batch = routing.copyEntries({
    sourcePane: localPane(['first.txt', 'second.txt']),
    targetPane: { ...makePane('b', 'local'), path: 'C:\\target' },
    names: ['first.txt', 'second.txt'],
    move: false,
    refreshTarget,
    overwriteApproved: true,
  });
  const settled = batch.then(() => 'done');

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(secondFinished).toBe(false);
  // Reporting the failure here, while a copy is still writing, would refresh the
  // pane and count the operation as over before it is.
  expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending');
  expect(refreshTarget).not.toHaveBeenCalled();

  releaseSecond();
  expect(await settled).toBe('done');
  expect(secondFinished).toBe(true);
  expect(setError).toHaveBeenCalledWith(expect.stringContaining('Copy denied'));
});
