import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSiteContainers,
  computeVisibleSiteOrder,
  FOLDERS,
  moveSiteToContainerEnd,
  moveSiteRelative,
  resolveVisibleSiteFocus,
  ROOT,
  siteContainersMatch,
} from '../../../src/features/sites/siteDragModel.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

const entries: ManagedSite[] = [
  { id: 'folder-a', kind: 'folder', name: 'Folder A' },
  { id: 'folder-b', kind: 'folder', name: 'Folder B' },
  { id: 'inside-a', kind: 'site', name: 'Inside A', parentId: 'folder-a' },
  { id: 'root-a', kind: 'site', name: 'Root A', parentId: null },
  { id: 'root-b', kind: 'site', name: 'Root B', parentId: null },
];

test('buildSiteContainers preserves the order inside each visible group', () => {
  assert.deepEqual(buildSiteContainers(entries), {
    [FOLDERS]: ['folder-a', 'folder-b'],
    [ROOT]: ['root-a', 'root-b'],
    'folder-a': ['inside-a'],
    'folder-b': [],
  });
});

test('visible tree order includes children only for expanded folders', () => {
  const containers = buildSiteContainers(entries);

  assert.deepEqual(computeVisibleSiteOrder(containers, new Set()), [
    { id: 'folder-a', kind: 'folder' },
    { id: 'folder-b', kind: 'folder' },
    { id: 'root-a', kind: 'site' },
    { id: 'root-b', kind: 'site' },
  ]);
  assert.deepEqual(computeVisibleSiteOrder(containers, new Set(['folder-a'])), [
    { id: 'folder-a', kind: 'folder' },
    { id: 'inside-a', kind: 'site' },
    { id: 'folder-b', kind: 'folder' },
    { id: 'root-a', kind: 'site' },
    { id: 'root-b', kind: 'site' },
  ]);
});

test('tree focus falls back to a collapsed child parent, then to the first visible row', () => {
  const collapsed = computeVisibleSiteOrder(buildSiteContainers(entries), new Set());

  assert.equal(resolveVisibleSiteFocus(collapsed, 'root-b'), 'root-b');
  assert.equal(resolveVisibleSiteFocus(collapsed, 'inside-a', 'folder-a'), 'folder-a');
  assert.equal(resolveVisibleSiteFocus(collapsed, 'deleted'), 'folder-a');
  assert.equal(resolveVisibleSiteFocus([], 'deleted'), null);
});

test('buildSiteContainers falls back a dangling parentId to root instead of dropping the site', () => {
  const withDanglingParent: ManagedSite[] = [
    ...entries,
    { id: 'orphan', kind: 'site', name: 'Orphan', parentId: 'deleted-folder' },
  ];

  const containers = buildSiteContainers(withDanglingParent);

  assert.deepEqual(containers[ROOT], ['root-a', 'root-b', 'orphan']);
  assert.equal(containers['deleted-folder'], undefined);
});

test('moveSiteToContainerEnd moves a root bookmark to the stable final slot', () => {
  const current = buildSiteContainers(entries);
  const next = moveSiteToContainerEnd(current, 'root-a', ROOT);

  assert.deepEqual(next[ROOT], ['root-b', 'root-a']);
  assert.deepEqual(current[ROOT], ['root-a', 'root-b']);
});

test('moveSiteToContainerEnd moves a folder child to the root end exactly once', () => {
  const current = buildSiteContainers(entries);
  const next = moveSiteToContainerEnd(current, 'inside-a', ROOT);

  assert.deepEqual(next['folder-a'], []);
  assert.deepEqual(next[ROOT], ['root-a', 'root-b', 'inside-a']);
  assert.equal(next[ROOT].filter((id) => id === 'inside-a').length, 1);
});

test('moving the existing last item is a referential no-op', () => {
  const current = buildSiteContainers(entries);
  assert.equal(moveSiteToContainerEnd(current, 'root-b', ROOT), current);
});

test('moveSiteRelative inserts before or after a row in another container', () => {
  const current = buildSiteContainers(entries);

  const before = moveSiteRelative(current, 'inside-a', ROOT, 'root-b', false);
  assert.deepEqual(before[ROOT], ['root-a', 'inside-a', 'root-b']);
  assert.deepEqual(before['folder-a'], []);

  const after = moveSiteRelative(current, 'inside-a', ROOT, 'root-b', true);
  assert.deepEqual(after[ROOT], ['root-a', 'root-b', 'inside-a']);
  assert.deepEqual(current['folder-a'], ['inside-a']);
});

test('moveSiteRelative refines the position after a live container projection', () => {
  const projected = {
    [FOLDERS]: ['folder-a'],
    [ROOT]: ['root-a'],
    'folder-a': ['inside-a', 'root-b'],
  };

  const before = moveSiteRelative(projected, 'root-b', 'folder-a', 'inside-a', false);
  assert.deepEqual(before['folder-a'], ['root-b', 'inside-a']);

  const after = moveSiteRelative(before, 'root-b', 'folder-a', 'inside-a', true);
  assert.deepEqual(after['folder-a'], ['inside-a', 'root-b']);
});

test('siteContainersMatch treats absent and empty folder buckets equally', () => {
  assert.equal(
    siteContainersMatch(
      { [FOLDERS]: ['folder-a'], [ROOT]: [], 'folder-a': [] },
      { [FOLDERS]: ['folder-a'], [ROOT]: [] },
    ),
    true,
  );
});
