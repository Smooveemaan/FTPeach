import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaneFileOperations } from '../../../src/features/file-browser/panes/createPaneFileOperations.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { paneClient } from '../helpers/paneClient.ts';

function harness(reply?: Parameters<typeof paneClient>[0]) {
  const h = paneClient(reply);
  const { panes } = makeTab('tab');
  panes.a.path = 'C:\\root';
  panes.b.path = '/root';
  panes.b.connectionId = 'session';
  const confirmations: { key: string; run: () => unknown }[] = [];
  const errors: unknown[] = [];
  const refreshes: unknown[][] = [];
  const navigations: unknown[][] = [];
  const operations = createPaneFileOperations({
    client: h.client,
    panes,
    activeTabId: 'tab',
    requestConfirm: (key, run) => {
      confirmations.push({ key, run });
    },
    reportError: (error) => {
      errors.push(error);
    },
    refreshPane: (...args) => {
      refreshes.push(args);
    },
    navigatePane: (...args) => {
      navigations.push(args);
    },
    t: (key) => key,
  });
  return { ...h, panes, operations, confirmations, errors, refreshes, navigations };
}

test('deletion waits for confirmation, ignores stale selections and refreshes the originating tab', async () => {
  const h = harness();
  h.operations.deletePaneSelected('a');
  assert.equal(h.confirmations.length, 0);
  h.panes.a.entries = [{ name: 'file', isDirectory: false }];
  h.panes.a.selected = new Set(['file', 'stale']);
  h.operations.deletePaneSelected('a', 'origin', true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations[0]!.key, 'confirm.deletePermanentSelected');
  await h.confirmations[0]!.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.args!.permanent, true);
  assert.deepEqual(h.refreshes, [['a', 'C:\\root', undefined, 'origin']]);
});

test('remote file creation refuses overwrite without IPC; failed mutations still refresh', async () => {
  const h = harness(() => ({ ok: false, error: 'denied', errorCode: 'permissionDenied' }));
  h.panes.b.entries = [{ name: 'existing', isDirectory: false }];
  await h.operations.submitNewFile('existing', 'tab', 'b');
  assert.equal(h.calls.length, 0);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.errors[0], 'errors.alreadyExists');
  await h.operations.submitNewFolder('folder', 'tab', 'b');
  await h.operations.submitNewFile('new', 'tab', 'b');
  await h.operations.renamePaneEntry('b', h.panes.b.entries[0]!, 'renamed');
  await h.operations.movePaneSamePane('b', ['one', 'two'], 'target');
  assert.equal(h.errors.length, 6);
  assert.equal(h.refreshes.length, 4);
  assert.deepEqual(
    h.calls.slice(-2).map((call) => call.args),
    [
      { connectionId: 'session', oldPath: '/root/one', newPath: '/root/target/one' },
      { connectionId: 'session', oldPath: '/root/two', newPath: '/root/target/two' },
    ],
  );
});

test('directory chooser cancellation does not navigate and a chosen home does', async () => {
  const h = harness((command) => (command.includes('homedir') ? 'C:\\Users\\me' : null));
  await h.operations.chooseLocalDir('a')();
  assert.deepEqual(h.navigations, []);
  await h.operations.goPaneHome('a')();
  assert.deepEqual(h.navigations, [['a', 'C:\\Users\\me']]);
});
