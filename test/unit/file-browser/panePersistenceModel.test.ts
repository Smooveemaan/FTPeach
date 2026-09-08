import assert from 'node:assert/strict';
import test from 'node:test';

import {
  restorePaneTabs,
  serializePaneTabs,
} from '../../../src/features/file-browser/panes/panePersistenceModel.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';

test('pane persistence restores local paths and saved remote site metadata', () => {
  const restored = restorePaneTabs(
    {
      activeTabId: 'saved-tab',
      tabs: [
        {
          id: 'saved-tab',
          name: 'Production',
          syncBrowsing: true,
          panes: {
            a: { kind: 'local', path: 'C:\\work' },
            b: { kind: 'remote', siteId: 'site-1', path: '/releases' },
          },
        },
      ],
    },
    [
      {
        id: 'site-1',
        kind: 'site',
        name: 'Deploy server',
        protocol: 'sftp',
        host: 'example.test',
        port: 2222,
        user: 'deploy',
        remotePath: '/home/deploy',
        hasPassword: true,
      },
    ],
  );

  assert.ok(restored);
  assert.equal(restored.activeTabId, 'saved-tab');
  assert.equal(restored.tabs[0]?.name, 'Production');
  assert.equal(restored.tabs[0]?.syncBrowsing, true);
  assert.equal(restored.tabs[0]?.panes.a.path, 'C:\\work');
  assert.equal(restored.tabs[0]?.panes.b.siteLabel, 'Deploy server');
  assert.equal(restored.tabs[0]?.panes.b.path, '/releases');
  assert.equal(restored.tabs[0]?.panes.b.form.port, '2222');
  assert.equal(restored.tabs[0]?.panes.b.form.password, '');
});

test('pane persistence uses safe fallbacks for missing ids, active tabs and sites', () => {
  const restored = restorePaneTabs(
    {
      activeTabId: 'missing',
      tabs: [{ panes: { b: { kind: 'remote', siteId: 'removed-site' } } }],
    },
    [],
    () => 'generated-tab',
  );

  assert.ok(restored);
  assert.equal(restored.activeTabId, 'generated-tab');
  assert.equal(restored.tabs[0]?.panes.a.kind, 'local');
  assert.equal(restored.tabs[0]?.panes.b.kind, 'remote');
  assert.equal(restored.tabs[0]?.panes.b.siteId, null);
});

test('pane persistence serializes only the durable tab fields', () => {
  const tab = makeTab('tab-1');
  tab.name = 'Work';
  tab.syncBrowsing = true;
  tab.panes.a.path = 'D:\\files';
  tab.panes.a.entries = [{ name: 'secret.txt', isDirectory: false }];
  tab.panes.b.siteId = 'site-1';
  tab.panes.b.path = '/uploads';
  tab.panes.b.connectionId = 'ephemeral-connection';
  tab.panes.b.form.password = 'must-not-persist';

  assert.deepEqual(serializePaneTabs([tab], tab.id), {
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        name: 'Work',
        syncBrowsing: true,
        panes: {
          a: { kind: 'local', path: 'D:\\files' },
          b: { kind: 'remote', siteId: 'site-1', path: '/uploads' },
        },
      },
    ],
  });
});

test('pane persistence returns no restoration for an empty session', () => {
  assert.equal(restorePaneTabs({}, []), null);
  assert.equal(restorePaneTabs({ tabs: [] }, []), null);
});
