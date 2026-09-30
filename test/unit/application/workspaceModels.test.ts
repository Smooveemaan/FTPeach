import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTab, otherPaneId } from '../../../src/features/file-browser/panes/paneModel.ts';
import {
  initialSectionResizeState,
  sectionResizeReducer,
} from '../../../src/app/layout/sectionResizeReducer.ts';

test('pane model creates independent local and remote pane state', () => {
  const tab = makeTab('tab-1');
  assert.equal(tab.panes.a.kind, 'local');
  assert.equal(tab.panes.b.kind, 'remote');
  assert.notEqual(tab.panes.a.selected, tab.panes.b.selected);
  assert.equal(otherPaneId('a'), 'b');
});

test('section resize reducer keeps one active gesture and durable touched flags', () => {
  const started = sectionResizeReducer(initialSectionResizeState, {
    type: 'start',
    section: 'transfers',
  });
  const touched = sectionResizeReducer(started, { type: 'touch', section: 'transfers' });
  const stopped = sectionResizeReducer(touched, { type: 'stop' });
  assert.equal(stopped.activeSection, null);
  assert.equal(stopped.transferManuallyResized, true);
  assert.equal(stopped.logManuallyResized, false);
});
