import { useCallback, useMemo, useReducer } from 'react';
import type { FileEntry, Translate } from '../../../shared/types.ts';
import type { SortKey } from './fileListModel.ts';
import { DEFAULT_FILE_SORT, filterAndSortEntries, nextFileSortState } from './fileListModel.ts';

interface UseFilePaneSortingOptions {
  entries: readonly FileEntry[];
  filterText: string;
  t: Translate;
}

export interface FilePaneSortingModel {
  nameAscExplicit: boolean;
  sortDir: 'desc' | 'asc';
  sortKey: SortKey;
  sortedEntries: FileEntry[];
  sortedFolderNames: string[];
  toggleSort: (key: SortKey) => void;
}

export default function useFilePaneSorting({
  entries,
  filterText,
  t,
}: UseFilePaneSortingOptions): FilePaneSortingModel {
  const [sort, selectSortKey] = useReducer(nextFileSortState, DEFAULT_FILE_SORT);
  const sortedEntries = useMemo(
    () =>
      filterAndSortEntries(entries, {
        filterText,
        sortKey: sort.key,
        sortDir: sort.direction,
        t,
      }),
    [entries, filterText, sort, t],
  );
  const sortedFolderNames = useMemo(
    () =>
      filterAndSortEntries(
        entries.filter((entry) => entry.isDirectory),
        { filterText: '', sortKey: sort.key, sortDir: sort.direction, t },
      ).map((entry) => entry.name),
    [entries, sort, t],
  );
  const toggleSort = useCallback((key: SortKey) => selectSortKey(key), []);

  return {
    nameAscExplicit: sort.nameAscendingExplicit,
    sortDir: sort.direction,
    sortKey: sort.key,
    sortedEntries,
    sortedFolderNames,
    toggleSort,
  };
}
