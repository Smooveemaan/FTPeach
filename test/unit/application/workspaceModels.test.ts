import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTab, otherPaneId } from '../../../src/features/file-browser/panes/paneModel.ts';

test('pane model creates independent local and remote pane state', () => {
  const tab = makeTab('tab-1');
  assert.equal(tab.panes.a.kind, 'local');
  assert.equal(tab.panes.b.kind, 'remote');
  assert.notEqual(tab.panes.a.selected, tab.panes.b.selected);
  assert.equal(otherPaneId('a'), 'b');
});
