import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferErrorCode,
  isDragOutTransferStarted,
  isPreviewProgress,
  isTransferProgress,
  isUpdaterStatus,
  normalizeCommandError,
  normalizeInvokeResponse,
} from '../../../src/platform/ipcContracts.ts';
import type {
  EventRegistrar,
  InvokeArgs,
  InvokeFn,
  InvokeResult,
  PayloadGuard,
} from '../../../src/platform/ipcContracts.ts';
import { createFilesystemApi } from '../../../src/platform/api/filesystem.ts';
import { createSessionApi } from '../../../src/platform/api/session.ts';
import { createSettingsApi } from '../../../src/platform/api/settings.ts';
import { createSitesApi } from '../../../src/platform/api/sites.ts';
import { createTransferApi } from '../../../src/platform/api/transfers.ts';
import { createTabsApi } from '../../../src/platform/api/tabs.ts';

test('normalizes typed and legacy command errors without dropping diagnostics', () => {
  assert.deepEqual(
    normalizeCommandError({ code: 'timedOut', message: 'Timeout', details: 'socket 1' }),
    {
      code: 'timedOut',
      message: 'Timeout',
      details: 'socket 1',
    },
  );
  assert.equal(inferErrorCode('Connection refused (os error 10061)'), 'connectionRefused');
  assert.deepEqual(normalizeInvokeResponse({ ok: false, error: 'Canceled by user' }), {
    ok: false,
    error: 'Canceled by user',
    errorCode: 'cancelled',
    diagnosticDetails: 'Canceled by user',
  });
});

test('validates event contracts before state receives them', () => {
  assert.equal(
    isTransferProgress({ id: '1', connectionId: 'c', status: 'progress', bytes: 2 }),
    true,
  );
  assert.equal(isTransferProgress({ id: '1', status: 'progress' }), false);
  assert.equal(
    isDragOutTransferStarted({
      id: 'd1',
      connectionId: 'c',
      protocol: 'sftp',
      name: 'a.bin',
      remoteFile: '/a.bin',
      total: 5,
    }),
    true,
  );
  assert.equal(
    isDragOutTransferStarted({ id: 'd1', connectionId: 'c', protocol: 'sftp', name: 'a.bin' }),
    false,
    'remoteFile is required',
  );
  assert.equal(
    isDragOutTransferStarted({
      id: 'd1',
      connectionId: 'c',
      protocol: 'gopher',
      name: 'a.bin',
      remoteFile: '/a.bin',
    }),
    false,
    'an unknown protocol must not reach the transfer store',
  );
  assert.equal(isPreviewProgress({ id: '1', connectionId: 'c', bytes: 1, total: 2 }), true);
  assert.equal(isUpdaterStatus({ state: 'downloaded', version: '1.2.3' }), true);
  assert.equal(isUpdaterStatus({ state: 'available', version: '1.2.3' }), true);
  assert.equal(isUpdaterStatus({ state: 'available' }), false);
  assert.equal(isUpdaterStatus({ state: 'downloading', version: '1.2.3', percent: 50 }), true);
  assert.equal(isUpdaterStatus({ state: 'error', message: 'network failed' }), true);
  assert.equal(isUpdaterStatus({ state: 'downloading', progress: 50 }), false);
  assert.equal(isUpdaterStatus({ state: 'surprise' }), false);
});

test('domain APIs preserve command names and camelCase argument contracts', async () => {
  const calls: Array<{ command: string; args?: InvokeArgs | undefined }> = [];
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    return { ok: true } as const;
  };
  const eventValidators = new Map<string, (_value: unknown) => boolean>();
  const onEvent: EventRegistrar = <T = unknown>(
    name: string,
    validate: PayloadGuard<T> = (_value: unknown): _value is T => true,
  ) => {
    eventValidators.set(name, validate);
    return () => () => {};
  };
  const session = createSessionApi(invoke);
  const transfer = createTransferApi(invoke, onEvent);
  const sites = createSitesApi(invoke);
  const settings = createSettingsApi(invoke);
  const tabs = createTabsApi(invoke);

  await session.rename('connection-1', '/old', '/new');
  await transfer.cancelRemoteCopy('source-1', 'target-1', 'transfer-1');
  await sites.applyLayout([{ id: 'site-1', parentId: 'folder-1' }]);
  await settings.set({ concurrency: 4 });
  await tabs.clear();

  assert.deepEqual(calls, [
    {
      command: 'session_rename',
      args: { connectionId: 'connection-1', oldPath: '/old', newPath: '/new' },
    },
    {
      command: 'transfer_cancel_remote_copy',
      args: {
        sourceConnectionId: 'source-1',
        targetConnectionId: 'target-1',
        transferId: 'transfer-1',
      },
    },
    {
      command: 'sites_apply_layout',
      args: { layout: [{ id: 'site-1', parentId: 'folder-1' }] },
    },
    { command: 'settings_set', args: { patch: { concurrency: 4 } } },
    { command: 'tabs_clear', args: undefined },
  ]);
  const validateProgress = eventValidators.get('transfer:progress');
  assert.ok(validateProgress);
  assert.equal(validateProgress({ id: '1', connectionId: 'c', status: 'done' }), true);
});

/**
 * Command responses used to be asserted into their declared type, so a backend
 * that answered with the wrong shape produced a value that merely claimed to be
 * one. These cases pin the behaviour that replaced the assertion: an
 * unrecognised response never reaches application code as if it were valid.
 */
test('a malformed command response is reduced to a reportable failure', async () => {
  const respondWith =
    (value: unknown): InvokeFn =>
    async <T>() =>
      value as InvokeResult<T>;

  const listedGarbage = await createSessionApi(
    respondWith({ ok: true, entries: 'not-an-array' }),
  ).list('c1', '/pub');
  assert.equal(listedGarbage.ok, false, 'a non-array entries field must not reach the pane');
  assert.deepEqual(listedGarbage.entries, []);
  assert.match(String(listedGarbage.error), /session_list/);

  const listedWrongEntries = await createSessionApi(
    respondWith({ ok: true, entries: [{ size: 12 }] }),
  ).list('c1', '/pub');
  assert.equal(listedWrongEntries.ok, false, 'an entry without a name is not a FileEntry');

  const listedFine = await createSessionApi(
    respondWith({ ok: true, entries: [{ name: 'a.txt' }] }),
  ).list('c1', '/pub');
  assert.equal(listedFine.ok, true);
  assert.equal(listedFine.entries.length, 1);

  // The failure the backend actually reported has to survive the check: a
  // rejected response is malformed against the success contract, but its error
  // is the thing worth showing.
  const refused = await createSessionApi(
    respondWith({ ok: false, error: 'Connection refused (os error 10061)' }),
  ).list('c1', '/pub');
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'connectionRefused');
  assert.equal(refused.error, 'Connection refused (os error 10061)');
});

test('command responses that carry no outcome fall back instead of being asserted', async () => {
  const respondWith =
    (value: unknown): InvokeFn =>
    async <T>() =>
      value as InvokeResult<T>;

  // `fs_homedir` used to be asserted to `string`, so a failed call handed the
  // pane a CommandResult object to navigate to.
  assert.equal(await createFilesystemApi(respondWith({ ok: false, error: 'x' })).homedir(), null);
  assert.equal(
    await createFilesystemApi(respondWith('C:\\Users\\dev')).homedir(),
    'C:\\Users\\dev',
  );
  assert.equal(await createFilesystemApi(respondWith('')).homedir(), null);

  assert.deepEqual(await createFilesystemApi(respondWith({ nope: 1 })).drives(), []);
  assert.deepEqual(
    await createFilesystemApi(respondWith([{ path: 'C:', label: 'System' }])).drives(),
    [{ path: 'C:', label: 'System' }],
  );
  assert.equal(await createFilesystemApi(respondWith('yes')).isDir('C:'), false);
  assert.equal(await createFilesystemApi(respondWith(null)).selectKeyFile(), null);
  assert.equal(await createFilesystemApi(respondWith({ path: 'k' })).selectKeyFile(), null);

  const settings = createSettingsApi(respondWith({ recentSiteIds: [7] }));
  assert.deepEqual(await settings.get(), {}, 'a recentSiteIds of numbers is not AppSettings');
  assert.deepEqual(
    await createSettingsApi(respondWith({ recentSiteIds: ['s1'], theme: 'dark' })).get(),
    { recentSiteIds: ['s1'], theme: 'dark' },
  );

  const tabs = createTabsApi(respondWith({ tabs: [{ panes: { a: { kind: 'ftp' } } }] }));
  assert.deepEqual(await tabs.get(), {}, 'an unknown pane kind must not restore a tab');
  assert.deepEqual(await createTabsApi(respondWith('tabs')).get(), {});

  const mutation = await createSitesApi(respondWith({ id: 'site-1' })).save({ id: 'site-1' });
  assert.equal(mutation.ok, false, 'a response without an outcome is not a successful save');
  assert.match(String(mutation.error), /sites_save/);
});
