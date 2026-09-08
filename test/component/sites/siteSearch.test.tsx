import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useSiteSearch } from '../../../src/features/sites/useSiteSearch.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

test('typing reuses search text and replacing site data invalidates the index', () => {
  let reads = 0;
  const folder: ManagedSite = { id: 'folder', name: 'Before', kind: 'folder' };
  const site: ManagedSite = {
    id: 'site',
    name: 'Site',
    parentId: 'folder',
    get host() {
      reads++;
      return 'example.test';
    },
  };
  const entries = [folder, site];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const { result, rerender } = renderHook((props) => useSiteSearch(props), {
    initialProps: { entries, entriesById },
  });
  const initialReads = reads;
  act(() => result.current.setSearchQuery('before'));
  expect(result.current.filteredSites).toEqual([site]);
  act(() => result.current.setSearchQuery('example'));
  expect(result.current.filteredSites).toEqual([site]);
  expect(reads).toBe(initialReads);
  const renamedFolder = { ...folder, name: 'After' };
  rerender({
    entries: [renamedFolder, site],
    entriesById: new Map([
      ['folder', renamedFolder],
      ['site', site],
    ]),
  });
  act(() => result.current.setSearchQuery('before'));
  expect(result.current.filteredSites).toEqual([]);
  act(() => result.current.setSearchQuery('after'));
  expect(result.current.filteredSites).toEqual([site]);
});
