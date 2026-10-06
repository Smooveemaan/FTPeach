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
  assert.equal(h.errors.length, 4);
  assert.equal(h.refreshes.length, 3);
});

test('rename replaces a target only on an explicit decision', async () => {
  const h = harness();
  h.panes.a.entries = [{ name: 'a.txt', isDirectory: false }];
  h.panes.b.entries = [
    { name: 'a.txt', isDirectory: false },
    { name: 'B.txt', isDirectory: false },
    { name: 'b.txt', isDirectory: false },
  ];
  await h.operations.renamePaneEntry('a', h.panes.a.entries[0]!, 'taken.txt');
  await h.operations.renamePaneEntry('a', h.panes.a.entries[0]!, 'A.txt');
  await h.operations.renamePaneEntry('b', h.panes.b.entries[0]!, 'taken.txt');
  // A case change on a server may land on the entry itself, not on another.
  await h.operations.renamePaneEntry('b', h.panes.b.entries[0]!, 'A.txt');
  // Here another entry already has the new name exactly.
  await h.operations.renamePaneEntry('b', h.panes.b.entries[1]!, 'b.txt');
  assert.deepEqual(
    h.calls.map((call) => call.args!.overwrite),
    [false, false, false, false, false],
  );
  assert.ok(h.calls.every((call) => call.command.endsWith('_rename')));
});

test('remote rename retries a conflicting case change only after explicit confirmation', async () => {
  const h = harness((_command, args) =>
    args?.overwrite
      ? { ok: true }
      : {
          ok: false,
          errorCode: 'alreadyExists',
          error: 'Target exists',
        },
  );
  const entry = { name: 'a.txt', isDirectory: false };
  // The listing need not contain the conflicting destination.
  h.panes.b.entries = [entry];
  await h.operations.renamePaneEntry('b', entry, 'A.txt', 'origin');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.args!.overwrite, false);
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.errors.length, 0);
  await h.confirmations[0]!.run();
  assert.equal(h.calls[1]!.args!.overwrite, true);
  assert.equal(h.refreshes[0]![3], 'origin');
});

test('remote permission errors do not offer an overwrite retry', async () => {
  const h = harness(() => ({ ok: false, errorCode: 'permissionDenied', error: 'Denied' }));
  await h.operations.renamePaneEntry('b', { name: 'a', isDirectory: false }, 'A');
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.errors.length, 1);
});

test('creating under a missing parent reports once without a second listing error', async () => {
  const h = harness(() => ({ ok: false, errorCode: 'notFound', error: 'Parent is gone' }));
  await h.operations.submitNewFolder('folder', 'tab', 'a');
  await h.operations.submitNewFile('file.txt', 'tab', 'a');
  assert.equal(h.calls.length, 2);
  assert.equal(h.errors.length, 2);
  assert.deepEqual(h.refreshes, []);
});

test('directory chooser cancellation does not navigate and a chosen home does', async () => {
  const h = harness((command) => (command.includes('homedir') ? 'C:\\Users\\me' : null));
  await h.operations.chooseLocalDir('a')();
  assert.deepEqual(h.navigations, []);
  await h.operations.goPaneHome('a')();
  assert.deepEqual(h.navigations, [['a', 'C:\\Users\\me']]);
});

test('remote deletion serializes case-only siblings without hiding real failures', async () => {
  let finish!: (_result: { ok: boolean }) => void;
  const held = new Promise<{ ok: boolean }>((resolve) => {
    finish = resolve;
  });
  const h = harness((_command, args) =>
    args?.remotePath === '/root/test.txt'
      ? held
      : { ok: false, error: 'denied', errorCode: 'permissionDenied' },
  );
  h.panes.b.entries = [
    { name: 'test.txt', isDirectory: false },
    { name: 'Test.txt', isDirectory: false },
  ];
  h.panes.b.selected = new Set(['test.txt', 'Test.txt']);
  h.operations.deletePaneSelected('b');
  const deleting = h.confirmations[0]!.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes.length, 0);
  finish({ ok: true });
  await deleting;
  assert.equal(h.calls.length, 2);
  assert.equal(h.errors.length, 1);
  assert.equal(h.refreshes.length, 1);
});
