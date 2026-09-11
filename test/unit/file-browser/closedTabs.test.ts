import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClosedTab } from '../../../src/features/file-browser/panes/closedTabs.ts';
import {
  CLOSED_TAB_LIMIT,
  insertTab,
  pushClosedTab,
  restoreClosedTab,
  snapshotClosedTab,
} from '../../../src/features/file-browser/panes/closedTabs.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';

function connectedTab(id: string) {
  const tab = makeTab(id);
  tab.name = 'Deploy';
  tab.syncBrowsing = true;
  tab.panes.a.path = 'C:\\work';
  tab.panes.a.history = ['C:\\'];
  tab.panes.a.selected.add('notes.txt');
  tab.panes.b = {
    ...tab.panes.b,
    status: 'connected',
    connectionId: 'connection-1',
    siteId: 'site-1',
    siteLabel: 'Deploy server',
    path: '/releases',
    form: { ...tab.panes.b.form, host: 'example.test', user: 'deploy' },
  };
  return tab;
}

test('a reopened tab keeps its name, folders and bookmark but not its old connection', () => {
  const closed = snapshotClosedTab(connectedTab('old'), 2);
  const tab = restoreClosedTab(closed, 'new');

  assert.equal(tab.id, 'new');
  assert.equal(tab.name, 'Deploy');
  assert.equal(tab.syncBrowsing, true);
  assert.equal(tab.panes.a.kind, 'local');
  assert.equal(tab.panes.a.path, 'C:\\work');
  assert.deepEqual(tab.panes.a.history, ['C:\\']);
  assert.equal(tab.panes.a.selected.size, 0);
  assert.equal(tab.panes.b.kind, 'remote');
  assert.equal(tab.panes.b.siteId, 'site-1');
  assert.equal(tab.panes.b.siteLabel, 'Deploy server');
  assert.equal(tab.panes.b.form.host, 'example.test');
  assert.equal(tab.panes.b.path, '/releases');
  assert.equal(tab.panes.b.status, 'idle');
  assert.equal(tab.panes.b.connectionId, null);
  assert.equal(closed.panes.a.reconnect, false);
  assert.equal(closed.panes.b.reconnect, true);
});

test('only a remote pane that was connected or connecting reconnects', () => {
  const tab = makeTab('tab');
  for (const [status, reconnect] of [
    ['connected', true],
    ['connecting', true],
    ['error', false],
    ['idle', false],
  ] as const) {
    tab.panes.b.status = status;
    assert.equal(snapshotClosedTab(tab, 0).panes.b.reconnect, reconnect, status);
  }
});

test('the last closed tab comes back first and the oldest drop off past the limit', () => {
  let stack: ClosedTab[] = [];
  for (let index = 0; index < CLOSED_TAB_LIMIT + 2; index += 1)
    stack = pushClosedTab(stack, snapshotClosedTab(makeTab(`tab-${index}`), index));

  assert.equal(stack.length, CLOSED_TAB_LIMIT);
  assert.equal(stack.at(-1)!.index, CLOSED_TAB_LIMIT + 1);
  assert.equal(stack[0]!.index, 2);
});

test('a reopened tab returns to its old place, or the end when fewer tabs are open', () => {
  const tabs = [makeTab('a'), makeTab('b')];
  const tab = makeTab('c');

  assert.deepEqual(
    insertTab(tabs, tab, 0).map(({ id }) => id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    insertTab(tabs, tab, 1).map(({ id }) => id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    insertTab(tabs, tab, 5).map(({ id }) => id),
    ['a', 'b', 'c'],
  );
});
