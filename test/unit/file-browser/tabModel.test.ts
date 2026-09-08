import assert from 'node:assert/strict';
import test from 'node:test';

import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { reorderTabs } from '../../../src/features/file-browser/panes/usePaneTabs.ts';

const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];

test('reorderTabs moves a tab to the hovered index in either direction', () => {
  assert.deepEqual(
    reorderTabs(tabs, 'c', 'a').map((tab) => tab.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    reorderTabs(tabs, 'a', 'b').map((tab) => tab.id),
    ['b', 'a', 'c'],
  );
});

test('reorderTabs is a referential no-op for invalid and unchanged moves', () => {
  assert.equal(reorderTabs(tabs, 'a', 'a'), tabs);
  assert.equal(reorderTabs(tabs, 'missing', 'b'), tabs);
});
