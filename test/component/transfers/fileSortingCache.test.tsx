import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import useFilePaneSorting from '../../../src/features/file-browser/components/useFilePaneSorting.ts';
import { filterAndSortEntries } from '../../../src/features/file-browser/components/fileListModel.ts';

test('filter edits reuse the full ordering and folder names, including stable ties', () => {
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    name: `file-${index}.txt`,
    isDirectory: index % 10 === 0,
    size: index % 7,
  }));
  const t = vi.fn((key: string) => key);
  const { result, rerender } = renderHook(
    ({ filter }) => useFilePaneSorting({ entries, filterText: filter, t }),
    { initialProps: { filter: '' } },
  );
  act(() => result.current.toggleSort('type'));
  const folderNames = result.current.sortedFolderNames;
  t.mockClear();
  rerender({ filter: 'FILE-1' });
  expect(t).not.toHaveBeenCalled();
  expect(result.current.sortedFolderNames).toBe(folderNames);
  expect(result.current.sortedEntries).toEqual(
    filterAndSortEntries(entries, { filterText: 'FILE-1', sortKey: 'type', sortDir: 'asc', t }),
  );
  rerender({ filter: '' });
  expect(result.current.sortedEntries).toHaveLength(1000);
});
