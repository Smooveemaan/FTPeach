import assert from 'node:assert/strict';
import test from 'node:test';

import { appendLogBatch } from '../../../src/features/logs/logBuffer.ts';
import { collectLiveConnectionIds } from '../../../src/features/open-with/useOpenWithLifecycle.ts';
import {
  pendingSecurityNotices,
  resolveBootstrapSettings,
} from '../../../src/app/useAppBootstrap.ts';
import { dispatchAppCommand } from '../../../src/app/useAppCommands.ts';
import { normalizeSettings } from '../../../src/features/settings/useSettings.ts';
import { dialogReducer, INITIAL_DIALOG_STATE } from '../../../src/app/useAppDialogs.ts';
import {
  buildPaneSitePayload,
  orderConnectableSites,
} from '../../../src/features/sites/useSites.ts';
import {
  moveToFolders,
  permissionStringToOctal,
} from '../../../src/features/file-browser/usePaneActions.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

type PaneSiteSource = Parameters<typeof buildPaneSitePayload>[1];
type ConnectionTab = Parameters<typeof collectLiveConnectionIds>[0][number];
type ConnectionPane = ConnectionTab['panes']['a'];

test('moveToFolders excludes every selected source folder without changing display order', () => {
  assert.deepEqual(moveToFolders(['beta', 'alpha'], ['gamma', 'alpha', 'delta', 'beta']), [
    'gamma',
    'delta',
  ]);
});

test('permissionStringToOctal converts SFTP listing permissions and has a safe fallback', () => {
  assert.equal(permissionStringToOctal('rwxr-x---'), '750');
  assert.equal(permissionStringToOctal('rw-r--r--'), '644');
  assert.equal(permissionStringToOctal(undefined), '644');
});

test('orderConnectableSites filters folders and keeps MRU sites first', () => {
  const sites: ManagedSite[] = [
    { id: 'one', name: 'One' },
    { id: 'folder', kind: 'folder', name: 'Folder' },
    { id: 'two', name: 'Two' },
    { id: 'three', name: 'Three' },
  ];
  assert.deepEqual(
    orderConnectableSites(sites, ['one', 'missing']).map((site) => site.id),
    ['one', 'three', 'two'],
  );
});

test('buildPaneSitePayload reuses a matching site and resolves the default SFTP port', () => {
  const pane: PaneSiteSource = {
    path: '/home/user',
    form: {
      protocol: 'sftp',
      host: 'example.com',
      port: '',
      user: 'me',
      password: 'secret',
      webdavUrl: '',
      allowInvalidCert: false,
      caCertPath: '',
      useKeyAuth: false,
      keyPath: '',
      keyPassphrase: '',
    },
  };
  const payload = buildPaneSitePayload('Renamed', pane, [
    { id: 'saved', name: 'Saved', protocol: 'sftp', host: 'example.com', port: 22, user: 'me' },
  ]);

  assert.equal(payload.id, 'saved');
  assert.equal(payload.port, 22);
  assert.equal(payload.remotePath, '/home/user');
});

test('buildPaneSitePayload does not overwrite a site on a different port', () => {
  const pane: PaneSiteSource = {
    path: '/',
    form: {
      protocol: 'ftp',
      host: 'example.com',
      port: '2121',
      user: 'me',
      password: 'secret',
      webdavUrl: '',
      allowInvalidCert: false,
      caCertPath: '',
      useKeyAuth: false,
      keyPath: '',
      keyPassphrase: '',
    },
  };
  const payload = buildPaneSitePayload('Test instance', pane, [
    {
      id: 'production',
      name: 'Production',
      protocol: 'ftp',
      host: 'example.com',
      port: 21,
      user: 'me',
    },
  ]);

  assert.equal(payload.id, undefined);
  assert.equal(payload.port, 2121);
});

test('buildPaneSitePayload falls back to the protocol default port for unparsable input', () => {
  const pane: PaneSiteSource = {
    path: '/',
    form: {
      protocol: 'ftp',
      host: 'example.com',
      port: '21x',
      user: 'me',
      password: 'secret',
      webdavUrl: '',
      allowInvalidCert: false,
      caCertPath: '',
      useKeyAuth: false,
      keyPath: '',
      keyPassphrase: '',
    },
  };
  const payload = buildPaneSitePayload('Test instance', pane, []);

  assert.equal(payload.port, 21);
});

test('dialogReducer supports functional updates for queued dialogs', () => {
  const first = () => 'first';
  const second = () => 'second';
  const withFirst = dialogReducer(INITIAL_DIALOG_STATE, {
    type: 'set',
    name: 'vaultUnlockRetries',
    value: (current) => [...current, first],
  });
  const withBoth = dialogReducer(withFirst, {
    type: 'set',
    name: 'vaultUnlockRetries',
    value: (current) => [...current, second],
  });

  assert.deepEqual(withBoth.vaultUnlockRetries, [first, second]);
  assert.equal(withBoth.showSettings, false);
});

test('normalizeSettings preserves zero-valued limits and migrates flat columns', () => {
  const normalized = normalizeSettings({
    concurrency: 0,
    connectTimeout: 0,
    localColumns: ['size'],
    localColumnWidths: { size: 120 },
  });

  assert.equal(normalized.transfers.concurrency, 0);
  assert.equal(normalized.connection.connectTimeout, 0);
  assert.deepEqual(normalized.layout.localColumns, { a: ['size'], b: ['size'] });
  assert.deepEqual(normalized.layout.localColumnWidths, {
    a: { size: 120 },
    b: { size: 120 },
  });
});

test('normalizeSettings disables an incomplete legacy proxy configuration', () => {
  const normalized = normalizeSettings({
    proxyEnabled: true,
    proxyHost: '',
    proxyPort: 1080,
  });
  assert.equal(normalized.connection.proxyEnabled, false);
});

test('normalizeSettings enables colored tabs by default and preserves an explicit opt-out', () => {
  assert.equal(normalizeSettings({}).interface.coloredTabs, true);
  assert.equal(normalizeSettings({ coloredTabs: false }).interface.coloredTabs, false);
});

test('normalizeSettings enables security confirmations by default and preserves an explicit opt-out', () => {
  assert.equal(normalizeSettings({}).security.showSecurityConfirmations, true);
  assert.equal(
    normalizeSettings({ showSecurityConfirmations: false }).security.showSecurityConfirmations,
    false,
  );
});

test('normalizeSettings keeps valid open-with associations and drops malformed entries', () => {
  const normalized = normalizeSettings({
    openWithAssociations: {
      TXT: 'C:\\Tools\\editor.exe',
      'bad extension': 'C:\\Tools\\bad.exe',
      png: 42,
    },
  });

  assert.deepEqual(normalized.transfers.openWithAssociations, { TXT: 'C:\\Tools\\editor.exe' });
});

test('dispatchAppCommand blocks application commands while a modal owns the keyboard', () => {
  let calls = 0;
  const handled = dispatchAppCommand('refresh', {
    modalOpen: true,
    openDevtools: () => {},
    refresh: () => calls++,
  });
  assert.equal(handled, false);
  assert.equal(calls, 0);
});

test('dispatchAppCommand always allows the devtools diagnostic command', () => {
  let calls = 0;
  const handled = dispatchAppCommand('open-devtools', {
    modalOpen: true,
    openDevtools: () => calls++,
  });
  assert.equal(handled, true);
  assert.equal(calls, 1);
});

test('resolveBootstrapSettings preserves an explicit language', () => {
  const stored = { language: 'de', theme: 'dark' };
  const result = resolveBootstrapSettings(stored, () => 'fr');

  assert.equal(result.settings, stored);
  assert.equal(result.detectedLanguage, null);
});

test('resolveBootstrapSettings detects a language only for a first launch', () => {
  assert.deepEqual(
    resolveBootstrapSettings({ theme: 'dark' }, () => 'fr'),
    {
      settings: { theme: 'dark', language: 'fr' },
      detectedLanguage: 'fr',
    },
  );
});

test('pendingSecurityNotices skips checks already acknowledged on disk', () => {
  assert.deepEqual(
    pendingSecurityNotices({
      legacyPasswordNoticeShown: true,
      plaintextSecretNoticeShown: false,
    }),
    { legacy: false, plaintext: true },
  );
});

test('appendLogBatch assigns stable ids and retains the newest lines', () => {
  let id = 10;
  const result = appendLogBatch(
    [{ message: 'old', id: 1 }],
    [{ message: 'first' }, { message: 'second' }],
    () => ++id,
    2,
  );

  assert.deepEqual(result, [
    { message: 'first', id: 11 },
    { message: 'second', id: 12 },
  ]);
});

test('collectLiveConnectionIds includes connected remote panes across all tabs', () => {
  const pane = (kind: string, status: string, connectionId: string | null): ConnectionPane => ({
    kind,
    status,
    connectionId,
  });
  const tabs: ConnectionTab[] = [
    { panes: { a: pane('remote', 'connected', 'one'), b: pane('local', 'connected', null) } },
    {
      panes: { a: pane('remote', 'disconnected', 'two'), b: pane('remote', 'connected', 'three') },
    },
  ];

  assert.deepEqual([...collectLiveConnectionIds(tabs)], ['one', 'three']);
});
