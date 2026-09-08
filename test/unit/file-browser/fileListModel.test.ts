import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareByKey,
  DEFAULT_FILE_SORT,
  filterAndSortEntries,
  fileIconName,
  nextFileSortState,
  shouldVirtualize,
} from '../../../src/features/file-browser/components/fileListModel.ts';

test('file pane model maps known extensions and keeps a neutral fallback', () => {
  assert.equal(fileIconName({ name: 'photo.PNG', isDirectory: false }), 'fileImage');
  assert.equal(fileIconName({ name: 'folder.png', isDirectory: true }), 'fileFolder');
  assert.equal(fileIconName({ name: 'README', isDirectory: false }), 'file');
});

test('file pane model comparators sort primitive column values', () => {
  const bySize = compareByKey('size', (key) => key);
  assert.ok(
    bySize(
      { name: 'small', isDirectory: false, size: 1 },
      { name: 'large', isDirectory: false, size: 2 },
    ) < 0,
  );

  const byName = compareByKey('name', (key) => key);
  assert.ok(byName({ name: 'a', isDirectory: false }, { name: 'b', isDirectory: false }) < 0);
});

test('file pane model filters case-insensitively and keeps folders first while sorting', () => {
  const entries = [
    { name: 'beta.txt', isDirectory: false },
    { name: 'Alpha folder', isDirectory: true },
    { name: 'alpha.txt', isDirectory: false },
    { name: 'ignored.txt', isDirectory: false },
  ];

  const result = filterAndSortEntries(entries, {
    filterText: 'ALPHA',
    sortKey: 'name',
    sortDir: 'desc',
    t: (key) => key,
  });

  assert.deepEqual(
    result.map((entry) => entry.name),
    ['Alpha folder', 'alpha.txt'],
  );
  assert.equal(entries.length, 4);
});

test('large directories keep the virtualized list boundary', () => {
  assert.equal(shouldVirtualize(200), false);
  assert.equal(shouldVirtualize(201), true);
  assert.equal(shouldVirtualize(10_000), true);
});

test('name sorting cycles through default, explicit ascending and descending states', () => {
  const explicitAscending = nextFileSortState(DEFAULT_FILE_SORT, 'name');
  assert.deepEqual(explicitAscending, {
    key: 'name',
    direction: 'asc',
    nameAscendingExplicit: true,
  });

  const descending = nextFileSortState(explicitAscending, 'name');
  assert.deepEqual(descending, {
    key: 'name',
    direction: 'desc',
    nameAscendingExplicit: true,
  });
  assert.equal(nextFileSortState(descending, 'name'), DEFAULT_FILE_SORT);
});

test('secondary column sorting returns to the implicit name order after descending', () => {
  const ascending = nextFileSortState(DEFAULT_FILE_SORT, 'size');
  assert.deepEqual(ascending, {
    key: 'size',
    direction: 'asc',
    nameAscendingExplicit: false,
  });

  const descending = nextFileSortState(ascending, 'size');
  assert.equal(descending.direction, 'desc');
  assert.equal(nextFileSortState(descending, 'size'), DEFAULT_FILE_SORT);
});
