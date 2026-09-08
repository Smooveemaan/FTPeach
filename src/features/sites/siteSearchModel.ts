import type { ManagedSite } from '../../shared/types.ts';

export interface SiteSearchEntry {
  entry: ManagedSite;
  text: string;
}

/** Rebuild only when site data changes; keystrokes reuse the normalized text. */
export function createSiteSearchIndex(
  entries: readonly ManagedSite[],
  entriesById: ReadonlyMap<string, ManagedSite>,
): SiteSearchEntry[] {
  return entries
    .filter((entry) => entry.kind !== 'folder')
    .map((entry) => ({
      entry,
      text: [
        entry.name,
        entry.host,
        entry.webdavUrl,
        entry.localPath,
        entry.user,
        entry.protocol,
        entry.parentId ? entriesById.get(entry.parentId)?.name : undefined,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    }));
}

/** Preserve site order and object identity while excluding folders from results. */
export function searchSites(index: readonly SiteSearchEntry[], query: string): ManagedSite[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return index.filter((item) => item.text.includes(normalized)).map((item) => item.entry);
}
