import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteSearchIndex, searchSites } from '../../../src/features/sites/siteSearchModel.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

test('indexed search preserves order and matches all public fields and parent names', () => {
  const entries: ManagedSite[] = [
    { id: 'folder', name: 'Production', kind: 'folder' },
    {
      id: 'one',
      name: 'First',
      host: 'example.test',
      user: 'Admin',
      protocol: 'sftp',
      parentId: 'folder',
    },
    { id: 'two', name: 'Second', kind: 'local', localPath: 'C:\\Work' },
    {
      id: 'three',
      name: 'Third',
      webdavUrl: 'https://dav.test',
      protocol: 'webdav',
      parentId: 'missing',
    },
  ];
  const index = createSiteSearchIndex(entries, new Map(entries.map((entry) => [entry.id, entry])));
  for (const query of [' FIRST ', 'EXAMPLE', 'admin', 'sftp', 'production'])
    assert.deepEqual(searchSites(index, query), [entries[1]]);
  assert.deepEqual(searchSites(index, 'work'), [entries[2]]);
  assert.deepEqual(searchSites(index, 'dav.test'), [entries[3]]);
  assert.deepEqual(searchSites(index, 'test'), [entries[1], entries[3]]);
  assert.equal(searchSites(index, 'first')[0], entries[1]);
  assert.deepEqual(searchSites(index, '  '), []);
  assert.deepEqual(searchSites(index, 'absent'), []);
});
