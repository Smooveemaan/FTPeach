import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  isDragOutTransferStarted,
  isPreviewProgress,
  isTransferProgress,
  isUpdaterStatus,
  normalizeCommandError,
  readyUnsubscribe,
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

test('recursive discard surfaces normalized cleanup failure with retained-path diagnostics', async () => {
  const invoke: InvokeFn = async () => ({
    ok: false,
    errorCode: 'cleanupIncomplete',
    error: 'Unverified objects were retained',
    diagnosticDetails: '[{"path":"/dst/a"}]',
  });
  const api = createTransferApi(invoke, () => () => readyUnsubscribe(() => {}));
  await assert.rejects(api.discardRecursive('attempt'), {
    code: 'cleanupIncomplete',
    message: 'Unverified objects were retained',
    details: '[{"path":"/dst/a"}]',
  });
});

test('a typed command error keeps its code and diagnostics; anything else is internal', () => {
  assert.deepEqual(
    normalizeCommandError({ code: 'timedOut', message: 'Timeout', details: 'socket 1' }),
    {
      code: 'timedOut',
      message: 'Timeout',
      details: 'socket 1',
    },
  );
  // The text is kept for the log, never read for a code.
  for (const untyped of [
    'Connection refused (os error 10061)',
    'Canceled by user',
    { code: 'somethingNew', message: 'From a newer backend' },
  ]) {
    assert.equal(normalizeCommandError(untyped).code, 'internal', JSON.stringify(untyped));
  }
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
    return () => readyUnsubscribe(() => {});
  };
  const session = createSessionApi(invoke);
  const transfer = createTransferApi(invoke, onEvent);
  const sites = createSitesApi(invoke);
  const settings = createSettingsApi(invoke);
  const tabs = createTabsApi(invoke);

  await session.rename('connection-1', '/old', '/new', false);
  await transfer.cancelRemoteCopy('source-1', 'target-1', 'transfer-1');
  await sites.applyLayout([{ id: 'site-1', parentId: 'folder-1' }]);
  await settings.set({ concurrency: 4 });
  await tabs.clear();

  assert.deepEqual(calls, [
    {
      command: 'session_rename',
      args: { connectionId: 'connection-1', oldPath: '/old', newPath: '/new', overwrite: false },
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

test('security settings go through their own confirmed command before the rest', async () => {
  const calls: Array<{ command: string; args?: InvokeArgs | undefined }> = [];
  let refuse = false;
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    return command === 'settings_set_security' && refuse
      ? { ok: false, error: 'Operation was cancelled', errorCode: 'cancelled' }
      : ({ ok: true } as const);
  };
  const settings = createSettingsApi(invoke);

  await settings.set({ theme: 'dark', showSecurityConfirmations: false, vaultAutoLockMinutes: 0 });
  assert.deepEqual(calls, [
    {
      command: 'settings_set_security',
      args: { patch: { showSecurityConfirmations: false, vaultAutoLockMinutes: 0 } },
    },
    { command: 'settings_set', args: { patch: { theme: 'dark' } } },
  ]);

  calls.length = 0;
  refuse = true;
  const result = await settings.set({ theme: 'light', showSecurityConfirmations: false });
  assert.equal(result.ok, false);
  assert.deepEqual(
    calls.map((call) => call.command),
    ['settings_set_security'],
  );
});

test('a protection relaxed with the user watching is saved on the grant it was confirmed with', async () => {
  const calls: Array<{ command: string; args?: InvokeArgs | undefined }> = [];
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    return { ok: true } as const;
  };
  const authorize = mock.fn(async () => 'granted-token');
  const settings = createSettingsApi(invoke, authorize);

  assert.deepEqual(await settings.confirmSecurityChange({ showSecurityConfirmations: false }), {
    ok: true,
  });
  assert.deepEqual(authorize.mock.calls[0]?.arguments, [
    'settings_set_security',
    '{"showSecurityConfirmations":false}',
  ]);

  // The confirmed change is applied on its own grant, ahead of the protected
  // settings that were not confirmed — applying those first withdraws it.
  await settings.set({
    theme: 'dark',
    showSecurityConfirmations: false,
    vaultAutoLockMinutes: 0,
  });
  assert.deepEqual(calls, [
    {
      command: 'settings_set_security',
      args: {
        patch: { showSecurityConfirmations: false },
        authorizationToken: 'granted-token',
      },
    },
    { command: 'settings_set_security', args: { patch: { vaultAutoLockMinutes: 0 } } },
    { command: 'settings_set', args: { patch: { theme: 'dark' } } },
  ]);

  // The grant is one save only, and a confirmation the user never saved is
  // forgotten rather than spent on a later change.
  calls.length = 0;
  await settings.set({ showSecurityConfirmations: false });
  assert.deepEqual(calls, [
    { command: 'settings_set_security', args: { patch: { showSecurityConfirmations: false } } },
    { command: 'settings_set', args: { patch: {} } },
  ]);

  calls.length = 0;
  await settings.confirmSecurityChange({ showSecurityConfirmations: false });
  settings.releaseSecurityChange();
  await settings.set({ showSecurityConfirmations: false });
  assert.deepEqual(calls, [
    { command: 'settings_set_security', args: { patch: { showSecurityConfirmations: false } } },
    { command: 'settings_set', args: { patch: {} } },
  ]);
});

test('a declined confirmation is reported as a cancellation and grants nothing', async () => {
  const calls: string[] = [];
  const invoke: InvokeFn = async (command) => {
    calls.push(command);
    return { ok: true } as const;
  };
  const settings = createSettingsApi(invoke, async () => {
    throw { code: 'cancelled', message: 'Operation was cancelled' };
  });

  const confirmation = await settings.confirmSecurityChange({ showSecurityConfirmations: false });
  assert.equal(confirmation.ok, false);
  assert.equal(confirmation.errorCode, 'cancelled');

  await settings.set({ showSecurityConfirmations: false });
  assert.deepEqual(calls, ['settings_set_security', 'settings_set']);
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

  const listedGarbage = await createSessionApi(respondWith({ entries: 'not-an-array' })).list(
    'c1',
    '/pub',
  );
  assert.equal(listedGarbage.ok, false, 'a listing that is not an array must not reach the pane');
  assert.deepEqual(listedGarbage.entries, []);
  assert.match(String(listedGarbage.error), /session_list/);

  const listedWrongEntries = await createSessionApi(respondWith([{ size: 12 }])).list('c1', '/pub');
  assert.equal(listedWrongEntries.ok, false, 'an entry without a name is not a FileEntry');

  for (const bad of [
    { name: 'a.txt' },
    { name: '', isDirectory: false },
    { name: 'a.txt', isDirectory: 'no' },
    { name: 'a.txt', isDirectory: false, size: -1 },
    { name: 'a.txt', isDirectory: false, size: Number.NaN },
    { name: 'a.txt', isDirectory: false, size: Number.POSITIVE_INFINITY },
    { name: 'a.txt', isDirectory: false, size: '12' },
    { name: 'a.txt', isDirectory: false, modifiedAt: {} },
    { name: 'a.txt', isDirectory: false, permissions: 644 },
  ]) {
    const remote = await createSessionApi(respondWith([bad])).list('c1', '/pub');
    assert.equal(remote.ok, false, `remote entry ${JSON.stringify(bad)} must be refused`);
    const local = await createFilesystemApi(respondWith({ path: 'C:\\', entries: [bad] })).list(
      'C:\\',
    );
    assert.equal(local.ok, false, `local entry ${JSON.stringify(bad)} must be refused`);
  }

  const listedFine = await createSessionApi(
    respondWith([
      { name: 'a.txt', isDirectory: false, size: 0, modifiedAt: null, permissions: null },
      { name: 'dir', isDirectory: true, size: 4096, modifiedAt: '2026-01-01T00:00:00Z' },
    ]),
  ).list('c1', '/pub');
  assert.equal(listedFine.ok, true);
  assert.equal(listedFine.entries.length, 2);

  // The failure the backend actually reported has to survive the check: a
  // rejected response is malformed against the success contract, but its error
  // is the thing worth showing.
  const refused = await createSessionApi(
    respondWith({
      ok: false,
      error: 'Connection refused (os error 10061)',
      errorCode: 'connectionRefused',
    }),
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
  // The store writes a null active tab when the one it named is gone.
  const emptySession = { activeTabId: null, tabs: [] };
  assert.deepEqual(await createTabsApi(respondWith(emptySession)).get(), emptySession);

  const mutation = await createSitesApi(respondWith({ id: 'site-1' })).save({ id: 'site-1' });
  assert.equal(mutation.ok, false, 'a response without an outcome is not a successful save');
  assert.match(String(mutation.error), /sites_save/);
});

test('a write that answers with nothing is a success, and a refusal stays one', async () => {
  const respondWith =
    (value: unknown): InvokeFn =>
    async <T>() =>
      value as InvokeResult<T>;

  // `tabs_set` and `tabs_clear` answer with nothing at all when they worked, so
  // the absence of an envelope is the success case and must not be reported as
  // an unrecognised shape.
  assert.deepEqual(await createTabsApi(respondWith(null)).set({ tabs: [] }), { ok: true });
  assert.deepEqual(await createTabsApi(respondWith(undefined)).clear(), { ok: true });

  const refused = await createTabsApi(
    respondWith({
      ok: false,
      error: 'Access is denied (os error 5)',
      errorCode: 'permissionDenied',
    }),
  ).set({ tabs: [] });
  assert.equal(refused.ok, false, 'a refused write must not pass for a stored session');
  assert.equal(refused.errorCode, 'permissionDenied');
  assert.equal(refused.error, 'Access is denied (os error 5)');

  const clearRefused = await createTabsApi(
    respondWith({ ok: false, errorCode: 'storageFull', error: 'The disk is full' }),
  ).clear();
  assert.equal(clearRefused.ok, false);
  assert.equal(clearRefused.errorCode, 'storageFull');
});

test('opening a local path runs programs and scripts only through the execute command', async () => {
  const commands: string[] = [];
  const api = createFilesystemApi(async (command) => {
    commands.push(command);
    return { ok: true };
  });
  for (const path of [
    'C:\\a.exe',
    'C:\\a.PS1',
    'C:\\setup.appref-ms',
    'C:\\a.pdf',
    'C:\\README',
    'C:\\dir.exe\\README',
  ])
    await api.openPath(path);
  assert.deepEqual(commands, [
    'fs_execute_path',
    'fs_execute_path',
    'fs_execute_path',
    'fs_open_document',
    'fs_open_document',
    'fs_open_document',
  ]);
});

test('a program is recognized by its extension under a Turkish locale too', async (t) => {
  // On a Turkish system the default locale lowercases "I" to a dotless "ı",
  // so "INF" no longer reads as "inf".
  t.mock.method(String.prototype, 'toLocaleLowerCase', () => 'ınf');
  const commands: string[] = [];
  const api = createFilesystemApi(async (command) => {
    commands.push(command);
    return { ok: true };
  });
  for (const path of ['C:\\a.INF', 'C:\\a.MSI', 'C:\\a.ISO']) await api.openPath(path);
  assert.deepEqual(commands, ['fs_execute_path', 'fs_execute_path', 'fs_execute_path']);
});
