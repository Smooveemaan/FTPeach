import i18n, { intlLocale } from '../../../i18n/index.ts';
import { formatBytes } from '../../../shared/format.ts';
import type { DateFormatter } from '../../settings/index.ts';
import type { FileEntry, Translate } from '../../../shared/types.ts';

export type { Translate } from '../../../shared/types.ts';
/**
 * The optional columns this build knows how to render and sort — the literal
 * keys of {@link COLUMN_DEFS}, not `string`.
 *
 * Column names are persisted in settings, so a settings file written by another
 * build can name a column that does not exist here. That is what
 * {@link isColumnKey} is for: the narrowing happens once, where the persisted
 * value enters, instead of every `COLUMN_DEFS[key]` lookup having to hope.
 */
export type ColumnKey = keyof typeof COLUMN_DEFS;

/** A column plus `name`, which is always shown and so is not a COLUMN_DEFS entry. */
export type SortKey = ColumnKey | 'name';

export interface FileSortState {
  key: SortKey;
  direction: 'asc' | 'desc';
  nameAscendingExplicit: boolean;
}

export const DEFAULT_FILE_SORT: FileSortState = {
  key: 'name',
  direction: 'asc',
  nameAscendingExplicit: false,
};

export function nextFileSortState(state: FileSortState, key: SortKey): FileSortState {
  if (key === 'name') {
    if (state.key !== 'name') {
      return { key: 'name', direction: 'asc', nameAscendingExplicit: true };
    }
    if (state.direction === 'asc' && !state.nameAscendingExplicit) {
      return { ...state, nameAscendingExplicit: true };
    }
    if (state.direction === 'asc') {
      return { key: 'name', direction: 'desc', nameAscendingExplicit: true };
    }
    return DEFAULT_FILE_SORT;
  }

  if (state.key !== key) {
    return { key, direction: 'asc', nameAscendingExplicit: false };
  }
  if (state.direction === 'asc') {
    return { ...state, direction: 'desc' };
  }
  return DEFAULT_FILE_SORT;
}

export const MIN_COLUMN_WIDTH = 50;
export const NAME_DEFAULT_WIDTH = 200;
export const DRAG_THRESHOLD_PX = 4;
export const VIRTUALIZE_THRESHOLD = 200;
export const shouldVirtualize = (entryCount: number): boolean => entryCount > VIRTUALIZE_THRESHOLD;

export { fileIconName } from '../../../shared/fileIcons.ts';

export function fileTypeLabel(entry: FileEntry, t: Translate): string {
  if (entry.isDirectory) return t('filePane.fileTypeFolder');
  const dot = entry.name.lastIndexOf('.');
  if (dot <= 0 || dot === entry.name.length - 1) return t('filePane.fileTypeGeneric');
  return t('filePane.fileTypeWithExt', { ext: entry.name.slice(dot + 1).toUpperCase() });
}

interface ColumnDefinition {
  defaultWidth: number;
  render: (entry: FileEntry, t: Translate, formatDate: DateFormatter) => string;
  sortValue: (entry: FileEntry, t: Translate) => string | number;
}

export const COLUMN_DEFS = {
  size: {
    defaultWidth: 84,
    render: (e) => (e.isDirectory ? '' : formatBytes(e.size)),
    sortValue: (e) => (e.isDirectory ? -1 : (e.size ?? 0)),
  },
  modifiedAt: {
    defaultWidth: 122,
    render: (e, _t, formatDate) => formatDate(e.modifiedAt),
    sortValue: (e) => (e.modifiedAt ? new Date(e.modifiedAt).getTime() : 0),
  },
  createdAt: {
    defaultWidth: 122,
    render: (e, _t, formatDate) => formatDate(e.createdAt),
    sortValue: (e) => (e.createdAt ? new Date(e.createdAt).getTime() : 0),
  },
  type: {
    defaultWidth: 130,
    render: (e, t) => fileTypeLabel(e, t),
    sortValue: (e, t) => fileTypeLabel(e, t),
  },
  permissions: {
    defaultWidth: 90,
    render: (e) => e.permissions || '—',
    sortValue: (e) => e.permissions || '',
  },
  owner: { defaultWidth: 100, render: (e) => e.owner || '—', sortValue: (e) => e.owner || '' },
  group: { defaultWidth: 100, render: (e) => e.group || '—', sortValue: (e) => e.group || '' },
} satisfies Record<string, ColumnDefinition>;

/** Narrows a column name that came from persisted settings. */
export function isColumnKey(value: unknown): value is ColumnKey {
  return typeof value === 'string' && Object.hasOwn(COLUMN_DEFS, value);
}

let cachedCollator: { locale: string; collator: Intl.Collator } | null = null;
function nameCollator(): Intl.Collator {
  const locale = intlLocale(i18n.language);
  if (cachedCollator?.locale !== locale) {
    cachedCollator = { locale, collator: new Intl.Collator(locale) };
  }
  return cachedCollator.collator;
}

export function compareByKey(key: SortKey, t: Translate): (a: FileEntry, b: FileEntry) => number {
  if (key === 'name') return (a, b) => nameCollator().compare(a.name, b.name);
  const { sortValue } = COLUMN_DEFS[key];
  return (a, b) => {
    const aValue = sortValue(a, t);
    const bValue = sortValue(b, t);
    if (typeof aValue === 'string' || typeof bValue === 'string') {
      return nameCollator().compare(String(aValue), String(bValue));
    }
    return aValue - bValue;
  };
}

function compareSortValues(
  aValue: string | number,
  bValue: string | number,
  collator: Intl.Collator,
): number {
  if (typeof aValue === 'string' || typeof bValue === 'string') {
    return collator.compare(String(aValue), String(bValue));
  }
  return aValue - bValue;
}

export function filterAndSortEntries(
  entries: readonly FileEntry[],
  {
    filterText = '',
    sortKey = 'name',
    sortDir = 'asc',
    t,
  }: { filterText?: string; sortKey?: SortKey; sortDir?: 'asc' | 'desc'; t: Translate },
): FileEntry[] {
  const normalizedFilter = filterText.toLowerCase();
  const filtered = normalizedFilter
    ? entries.filter((entry) => entry.name.toLowerCase().includes(normalizedFilter))
    : entries;
  const direction = sortDir === 'desc' ? -1 : 1;

  if (sortKey === 'name') {
    const collator = nameCollator();
    return [...filtered].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return collator.compare(a.name, b.name) * direction;
    });
  }

  // Column renderers can parse dates or translate labels. Cache their sort key once per entry
  // instead of recomputing it for every comparison performed by Array.sort.
  const { sortValue } = COLUMN_DEFS[sortKey];
  const decorated = filtered.map((entry) => ({ entry, value: sortValue(entry, t) }));
  const collator = nameCollator();

  decorated.sort((a, b) => {
    if (a.entry.isDirectory !== b.entry.isDirectory) return a.entry.isDirectory ? -1 : 1;
    return compareSortValues(a.value, b.value, collator) * direction;
  });
  return decorated.map(({ entry }) => entry);
}
