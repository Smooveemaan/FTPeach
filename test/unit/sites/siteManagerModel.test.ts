import assert from 'node:assert/strict';
import test from 'node:test';

import {
  entriesForManager,
  findProbableDuplicate,
  sortManagedEntries,
} from '../../../src/features/sites/siteManagerModel.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

const entries: ManagedSite[] = [
  { id: 'folder', kind: 'folder', name: 'Servers' },
  {
    id: 'z',
    kind: 'site',
    name: 'Zulu',
    protocol: 'sftp',
    host: 'same.test',
    port: 22,
    user: 'me',
    parentId: 'folder',
  },
  {
    id: 'a',
    kind: 'site',
    name: 'Alpha',
    protocol: 'ftp',
    host: 'ftp.test',
    port: 21,
    parentId: null,
  },
  { id: 'local', kind: 'local', name: 'Work', localPath: 'C:\\Work', parentId: null },
];

test('duplicate detection normalizes connection identity but excludes the edited entry', () => {
  assert.equal(
    findProbableDuplicate(entries, {
      id: 'candidate',
      name: 'Candidate',
      protocol: 'sftp',
      host: ' SAME.TEST ',
      port: 22,
      user: 'ME',
    })?.id,
    'z',
  );
  const second = entries[1];
  assert.ok(second);
  assert.equal(findProbableDuplicate(entries, second, 'z'), null);
});

test('name/protocol sorting preserves folders and their child grouping', () => {
  assert.deepEqual(
    sortManagedEntries(entries, 'name').map(({ id }) => id),
    ['folder', 'z', 'a', 'local'],
  );
  assert.deepEqual(sortManagedEntries(entries, 'manual'), entries);
});

test('manager entries stay in their scope and orphaned items return to the root', () => {
  const scoped: ManagedSite[] = [
    ...entries,
    { id: 'local-folder', kind: 'folder', name: 'Local', managerScope: 'localPaths' },
    {
      id: 'nested-local',
      kind: 'local',
      name: 'Nested local',
      localPath: 'D:\\Work',
      parentId: 'local-folder',
    },
    {
      id: 'orphan',
      kind: 'site',
      name: 'Orphan',
      protocol: 'sftp',
      parentId: 'missing-folder',
    },
  ];

  assert.deepEqual(
    entriesForManager(scoped, 'localPaths').map(({ id }) => id),
    ['local-folder', 'local', 'nested-local'],
  );
  assert.equal(
    entriesForManager(scoped, 'bookmarks').find(({ id }) => id === 'orphan')?.parentId,
    null,
  );
});

test('automatic sorting keeps folder order, stable siblings and root items without mutation', () => {
  const source: ManagedSite[] = [
    { id: 'b', kind: 'folder', name: 'Beta' },
    { id: 'a', kind: 'folder', name: 'Alpha' },
    { id: 'b2', name: 'Zulu', protocol: 'ftp', parentId: 'b' },
    { id: 'a1', name: 'Same', protocol: 'sftp', parentId: 'a' },
    { id: 'b1', name: 'Alpha', protocol: 'sftp', parentId: 'b' },
    { id: 'a2', name: 'Same', protocol: 'sftp', parentId: 'a' },
    { id: 'root', name: 'Root', protocol: 'ftp' },
  ];
  const snapshot = structuredClone(source);
  for (const entry of source) Object.freeze(entry);
  Object.freeze(source);
  assert.deepEqual(
    sortManagedEntries(source, 'name').map(({ id }) => id),
    ['a', 'b', 'a1', 'a2', 'b1', 'b2', 'root'],
  );
  assert.deepEqual(
    sortManagedEntries(source, 'protocol').map(({ id }) => id),
    ['a', 'b', 'a1', 'a2', 'b2', 'b1', 'root'],
  );
  assert.strictEqual(sortManagedEntries(source, 'manual'), source);
  for (const entry of sortManagedEntries(source, 'name')) {
    assert.strictEqual(
      entry,
      source.find(({ id }) => id === entry.id),
    );
  }
  assert.deepEqual(source, snapshot);
});

test('automatic sorting handles a folder larger than the argument limit', () => {
  const folder: ManagedSite = { id: 'folder', kind: 'folder', name: 'Folder' };
  const children: ManagedSite[] = Array.from({ length: 150_000 }, (_, index) => ({
    id: String(index),
    name: 'Site',
    parentId: folder.id,
  }));
  assert.deepEqual(sortManagedEntries([folder, ...children], 'name'), [folder, ...children]);
});
