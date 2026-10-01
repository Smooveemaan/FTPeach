// What feature code receives from `platform/api` for commands that used to
// report failure in more than one way. Each case replays what the backend
// sends and runs it through the real `invoke` and the real wrapper; the
// expected values are what features read, and were recorded before the
// backend moved every failure to a rejection.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const rawInvoke = vi.fn<(_command: string, _args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: rawInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const { tauriApi: api } = await import('../../../src/platform/tauriApi.ts');

type Wire = { resolve: unknown } | { reject: unknown };

/** A backend failure as `CommandError` serializes it. */
const ERROR = { code: 'notFound', message: 'File or folder not found', details: 'os error 2' };
const CANCELLED = { code: 'cancelled', message: 'Operation cancelled' };
/** What features read from any failed command. */
const FAILED = { ok: false, error: 'File or folder not found', errorCode: 'notFound' };

const entry = { name: 'a.txt', isDirectory: false, isHidden: false, size: 1, modifiedAt: null };

interface Case {
  name: string;
  command: string;
  /** Goes through `authorize_sensitive` and the `sensitive` plugin. */
  sensitive?: boolean;
  call: () => Promise<unknown>;
  /** Every successful state: what the backend sends, and what features read. */
  success: { wire: Wire; seen: unknown }[];
  /** Fields a failed result carries besides the error. */
  failedExtra?: Record<string, unknown>;
}

const resolve = (value: unknown): Wire => ({ resolve: value });
/** A `CommandResult<()>`: nothing on success, a rejection on failure. */
const voidCase = (name: string, command: string, call: () => Promise<unknown>): Case => ({
  name,
  command,
  call,
  success: [{ wire: resolve(null), seen: { ok: true } }],
});
const vault = voidCase;
const sensitiveVoid = (name: string, command: string, call: () => Promise<unknown>): Case => ({
  ...voidCase(name, command, call),
  sensitive: true,
});

const cases: Case[] = [
  // Sites
  {
    name: 'sites.save',
    command: 'sites_save',
    sensitive: true,
    call: () => api.sites.save({ id: 's1', name: 'Site' }),
    success: [
      {
        wire: resolve({ id: 's1', secretNotPersisted: false }),
        seen: { ok: true, id: 's1', secretNotPersisted: false },
      },
      {
        wire: resolve({ id: 's1', secretNotPersisted: true }),
        seen: { ok: true, id: 's1', secretNotPersisted: true },
      },
    ],
  },
  voidCase('sites.delete', 'sites_delete', () => api.sites.delete('s1')),
  {
    name: 'sites.saveFolder',
    command: 'sites_save_folder',
    call: () => api.sites.saveFolder({ name: 'Folder' }),
    success: [
      {
        wire: resolve({ id: 'f1', secretNotPersisted: false }),
        seen: { ok: true, id: 'f1', secretNotPersisted: false },
      },
    ],
  },
  voidCase('sites.deleteFolder', 'sites_delete_folder', () => api.sites.deleteFolder('f1')),
  voidCase('sites.applyLayout', 'sites_apply_layout', () => api.sites.applyLayout([])),
  {
    name: 'sites.revealSecret',
    command: 'sites_reveal_secret',
    sensitive: true,
    call: () => api.sites.revealSecret('s1', 'password'),
    success: [
      { wire: resolve('pw'), seen: { ok: true, value: 'pw' } },
      // Nothing stored is a success with nothing in it.
      { wire: resolve(null), seen: { ok: true } },
    ],
  },
  // Vault
  vault('vault.setup', 'vault_setup', () => api.vault.setup('master')),
  vault('vault.unlock', 'vault_unlock', () => api.vault.unlock('master')),
  vault('vault.lock', 'vault_lock', () => api.vault.lock()),
  vault('vault.enableSystemUnlock', 'vault_enable_system_unlock', () =>
    api.vault.enableSystemUnlock(),
  ),
  vault('vault.unlockSystem', 'vault_unlock_system', () => api.vault.unlockSystem()),
  vault('vault.disableSystemUnlock', 'vault_disable_system_unlock', () =>
    api.vault.disableSystemUnlock(),
  ),
  vault('vault.changePassword', 'vault_change_password', () =>
    api.vault.changePassword('old', 'new'),
  ),
  { ...vault('vault.reset', 'vault_reset', () => api.vault.reset()), sensitive: true },
  {
    ...vault('vault.useSystemProtection', 'vault_use_system_protection', () =>
      api.vault.useSystemProtection(),
    ),
    sensitive: true,
  },
  // Local files
  {
    name: 'fsLocal.list',
    command: 'fs_list',
    call: () => api.fsLocal.list('C:\\'),
    success: [
      {
        wire: resolve({ path: 'C:\\', entries: [entry] }),
        seen: { ok: true, path: 'C:\\', entries: [entry] },
      },
    ],
    failedExtra: { path: 'C:\\', entries: [] },
  },
  voidCase('fsLocal.mkdir', 'fs_mkdir', () => api.fsLocal.mkdir('C:\\a')),
  voidCase('fsLocal.rename', 'fs_rename', () => api.fsLocal.rename('C:\\a', 'C:\\b', false)),
  voidCase('fsLocal.copyFile', 'fs_copy_file', () => api.fsLocal.copyFile('C:\\a', 'C:\\b')),
  voidCase('fsLocal.validateCopy', 'fs_validate_copy', () =>
    api.fsLocal.validateCopy('C:\\a', 'C:\\b'),
  ),
  voidCase('fsLocal.createFile', 'fs_create_file', () => api.fsLocal.createFile('C:\\a')),
  sensitiveVoid('fsLocal.delete', 'fs_delete', () => api.fsLocal.delete('C:\\a')),
  sensitiveVoid('fsLocal.revealPath', 'fs_reveal_path', () => api.fsLocal.revealPath('C:\\a')),
  sensitiveVoid('fsLocal.openPath (document)', 'fs_open_document', () =>
    api.fsLocal.openPath('C:\\a.pdf'),
  ),
  sensitiveVoid('fsLocal.openPath (program)', 'fs_execute_path', () =>
    api.fsLocal.openPath('C:\\a.exe'),
  ),
  // Sessions
  voidCase('session.cancelConnect', 'session_cancel_connect', () => api.session.cancelConnect('c')),
  voidCase('session.disconnect', 'session_disconnect', () => api.session.disconnect('c')),
  {
    name: 'session.list',
    command: 'session_list',
    call: () => api.session.list('c', '/'),
    success: [
      {
        wire: resolve([entry]),
        seen: { ok: true, entries: [entry] },
      },
    ],
    failedExtra: { entries: [] },
  },
  voidCase('session.mkdir', 'session_mkdir', () => api.session.mkdir('c', '/a')),
  voidCase('session.createFile', 'session_create_file', () => api.session.createFile('c', '/a')),
  voidCase('session.delete', 'session_delete', () => api.session.delete('c', '/a', false)),
  voidCase('session.rename', 'session_rename', () => api.session.rename('c', '/a', '/b', false)),
  voidCase('session.chmod', 'session_chmod', () => api.session.chmod('c', '/a', '644')),
  sensitiveVoid('session.trustHostKey', 'session_trust_host_key', () =>
    api.session.trustHostKey({ host: 'h', port: 22, actual: 'SHA256:new' }),
  ),
  // Transfers
  voidCase('transfer.upload', 'transfer_upload', () =>
    api.transfer.upload('c', 't', 'C:\\a', '/a', false),
  ),
  voidCase('transfer.download', 'transfer_download', () =>
    api.transfer.download('c', 't', '/a', 'C:\\a', false),
  ),
  voidCase('transfer.remoteCopy', 'transfer_remote_copy', () =>
    api.transfer.remoteCopy('c1', 'c2', 't', '/a', '/b'),
  ),
  voidCase('transfer.validateRemoteCopy', 'transfer_validate_remote_copy', () =>
    api.transfer.validateRemoteCopy('/a', '/b', 'c1', 'c2', false),
  ),
  voidCase('transfer.cancel', 'transfer_cancel', () => api.transfer.cancel('c', 't', 'stop')),
  voidCase('transfer.cancelRemoteCopy', 'transfer_cancel_remote_copy', () =>
    api.transfer.cancelRemoteCopy('c1', 'c2', 't'),
  ),
  // Updater
  voidCase('updater.check', 'updater_check', () => api.updater.check()),
  voidCase('updater.download', 'updater_download', () => api.updater.download()),
  voidCase('updater.install', 'updater_install', () => api.updater.install()),
  // Open with
  {
    name: 'openWith.start',
    command: 'open_with_start',
    sensitive: true,
    call: () => api.openWith.start('c', '/a.txt', 'id', null),
    success: [
      {
        wire: resolve({ localPath: 'C:\\t\\a.txt' }),
        seen: { ok: true, localPath: 'C:\\t\\a.txt' },
      },
    ],
  },
  voidCase('openWith.markSynced', 'open_with_mark_synced', () =>
    api.openWith.markSynced('id', 'r1'),
  ),
  voidCase('openWith.revealRecoveredEdits', 'open_with_reveal_recovered_edits', () =>
    api.openWith.revealRecoveredEdits(),
  ),
  voidCase('openWith.discardRecoveredEdits', 'open_with_discard_recovered_edits', () =>
    api.openWith.discardRecoveredEdits(),
  ),
  // Drag out
  voidCase('dragOut.start', 'drag_out_start', () => api.dragOut.start('c', 'sftp', [])),
  voidCase('dragOut.startLocal', 'drag_out_start_local', () => api.dragOut.startLocal([])),
  // Proxy
  voidCase('proxy.test', 'proxy_test', () => api.proxy.test({ proxyHost: 'p', targetHost: 't' })),
  // Application
  {
    name: 'app.resetLayout',
    command: 'app_reset_layout',
    call: () => api.app.resetLayout(),
    success: [
      {
        wire: resolve({ settings: { theme: 'dark' } }),
        seen: { ok: true, settings: { theme: 'dark' } },
      },
    ],
  },
  {
    name: 'app.exportSettings',
    command: 'app_export_settings',
    sensitive: true,
    call: () =>
      api.app.exportSettings({
        includeSettings: true,
        includeBookmarks: true,
        includeLocalPaths: true,
      }),
    success: [
      {
        wire: resolve({ result: 'ok', ok: true, path: 'C:\\s.json' }),
        seen: { ok: true, path: 'C:\\s.json' },
      },
      {
        wire: resolve({ result: 'canceled', ok: false, canceled: true }),
        seen: { ok: false, canceled: true },
      },
    ],
  },
  {
    name: 'app.importSettings',
    command: 'app_import_settings',
    sensitive: true,
    call: () =>
      api.app.importSettings({
        includeSettings: true,
        includeBookmarks: true,
        includeLocalPaths: true,
      }),
    success: [
      {
        wire: resolve({
          result: 'ok',
          ok: true,
          settings: { theme: 'dark' },
          sitesAdded: 2,
          sitesSkipped: 1,
        }),
        seen: { ok: true, settings: { theme: 'dark' }, sitesAdded: 2, sitesSkipped: 1 },
      },
      {
        wire: resolve({ result: 'canceled', ok: false, canceled: true }),
        seen: { ok: false, canceled: true },
      },
    ],
  },
];

/**
 * What a feature reads from a result. `result` is the backend's serde tag and
 * `diagnosticDetails` goes to the log, `issues` to nothing: no feature reads
 * any of them. A field that is null is read the same as a missing one.
 */
function seen(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, field]) =>
        field != null && key !== 'result' && key !== 'diagnosticDetails' && key !== 'issues',
    ),
  );
}

function answer(target: Case, wire: Wire, authorize: Wire = resolve({ token: 'grant' })) {
  rawInvoke.mockImplementation(async (command) => {
    const reply = (next: Wire) => ('reject' in next ? Promise.reject(next.reject) : next.resolve);
    if (command === 'plugin:sensitive|authorize_sensitive') return reply(authorize);
    const expected = target.sensitive ? `plugin:sensitive|${target.command}` : target.command;
    if (command !== expected) throw new Error(`unexpected command ${command}`);
    return reply(wire);
  });
}

beforeEach(() => {
  // A response shape the wrapper does not accept is reported on the console;
  // none of these cases may produce one.
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    throw new Error(`console.error: ${args.map(String).join(' ')}`);
  });
});
afterEach(() => {
  rawInvoke.mockReset();
  vi.restoreAllMocks();
});

test.each(cases)('$name: success', async (target) => {
  for (const { wire, seen: expected } of target.success) {
    answer(target, wire);
    expect(seen(await target.call())).toEqual(expected);
  }
});

test.each(cases)('$name: a failure', async (target) => {
  answer(target, { reject: ERROR });
  expect(seen(await target.call())).toEqual({ ...FAILED, ...target.failedExtra });
});

test.each(cases.filter((target) => target.sensitive))(
  '$name: a declined confirmation reads as cancelled',
  async (target) => {
    answer(target, resolve(null), { reject: CANCELLED });
    expect(seen(await target.call())).toEqual({
      ok: false,
      error: 'Operation cancelled',
      errorCode: 'cancelled',
      ...target.failedExtra,
    });
    expect(rawInvoke).not.toHaveBeenCalledWith(
      `plugin:sensitive|${target.command}`,
      expect.anything(),
    );
  },
);

const connectCase: Case = {
  name: 'session.connect',
  command: 'session_connect',
  call: () =>
    api.session.connect(
      'c',
      { kind: 'savedSite', siteId: 's' },
      { timeoutMs: 20000, activeMode: false },
    ),
  success: [],
};
const changedKey = { host: 'h', port: 22, expected: 'SHA256:old', actual: 'SHA256:new' };
const unconfirmedKey = { host: 'h', port: 22, actual: 'SHA256:new' };

test('session.connect: a connection that opens', async () => {
  answer(connectCase, resolve({ outcome: 'connected' }));
  expect(seen(await connectCase.call())).toEqual({ ok: true });
});

test('session.connect: a failure', async () => {
  answer(connectCase, { reject: ERROR });
  expect(seen(await connectCase.call())).toEqual(FAILED);
});

test('session.connect: a locked vault reads as vaultLocked', async () => {
  const locked = { code: 'vaultLocked', message: 'Vault is locked' };
  answer(connectCase, { reject: locked });
  expect(seen(await connectCase.call())).toEqual({
    ok: false,
    error: 'Vault is locked',
    errorCode: 'vaultLocked',
  });
});

test.each([
  ['changed', changedKey],
  ['unconfirmed', unconfirmedKey],
])('session.connect: a %s host key hands the decision to the caller', async (_kind, key) => {
  answer(connectCase, resolve({ outcome: 'hostKeyUnconfirmed', ...key }));
  // The caller branches on `hostKeyMismatch` and never reads `error` here.
  expect(seen(await connectCase.call())).toEqual({
    ok: false,
    errorCode: 'hostKeyMismatch',
    hostKeyMismatch: key,
  });
});

test('only a failure nothing classified is logged, with its details', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = cases.find((candidate) => candidate.name === 'sites.delete')!;
  for (const expected of [
    ERROR,
    CANCELLED,
    { code: 'authFailed', message: 'Authentication failed' },
  ]) {
    answer(target, { reject: expected });
    await target.call();
  }
  expect(warn).not.toHaveBeenCalled();

  answer(target, { reject: { code: 'internal', message: 'Command failed', details: 'raw chain' } });
  await target.call();
  answer(target, { reject: 'invalid args `id` for command `sites_delete`' });
  await target.call();
  expect(warn.mock.calls).toEqual([
    ['sites_delete failed: Command failed', 'raw chain'],
    [
      'sites_delete failed: invalid args `id` for command `sites_delete`',
      'invalid args `id` for command `sites_delete`',
    ],
  ]);
});
