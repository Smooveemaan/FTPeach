import type { ManagedSite } from '../../shared/types.ts';

export type SiteSortMode = 'manual' | 'name' | 'protocol';
export type SiteManagerKind = 'bookmarks' | 'localPaths';
type SiteIdentityCandidate = Pick<ManagedSite, 'name'> & Partial<ManagedSite>;

export function entriesForManager(
  entries: readonly ManagedSite[],
  managerKind: SiteManagerKind,
): ManagedSite[] {
  const isLocalPathManager = managerKind === 'localPaths';
  const folders = entries.filter(
    (entry) =>
      entry.kind === 'folder' &&
      (isLocalPathManager
        ? entry.managerScope === 'localPaths'
        : entry.managerScope !== 'localPaths'),
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const items = entries
    .filter((entry) =>
      isLocalPathManager
        ? entry.kind === 'local'
        : entry.kind !== 'folder' && entry.kind !== 'local',
    )
    .map((entry) =>
      entry.parentId && !folderIds.has(entry.parentId) ? { ...entry, parentId: null } : entry,
    );
  return [...folders, ...items];
}

export function connectionIdentity(entry: SiteIdentityCandidate): string {
  if (entry.kind === 'local')
    return `local|${String(entry.localPath || '')
      .trim()
      .toLowerCase()}`;
  const address = entry.protocol === 'webdav' ? entry.webdavUrl : entry.host;
  return [entry.protocol, address, entry.port || '', entry.user || '']
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    )
    .join('|');
}

export function findProbableDuplicate(
  entries: readonly ManagedSite[],
  candidate: SiteIdentityCandidate,
  editingId: string | null = null,
): ManagedSite | null {
  const identity = connectionIdentity(candidate);
  if (!identity.replaceAll('|', '')) return null;
  return (
    entries.find(
      (entry) =>
        entry.kind !== 'folder' && entry.id !== editingId && connectionIdentity(entry) === identity,
    ) || null
  );
}

export function sortManagedEntries(
  entries: readonly ManagedSite[],
  mode: SiteSortMode,
): readonly ManagedSite[] {
  if (mode === 'manual') return entries;
  const folders = entries.filter((entry) => entry.kind === 'folder');
  const itemsByParent = new Map<string | null, ManagedSite[]>();
  for (const entry of entries) {
    if (entry.kind === 'folder') continue;
    const parent = entry.parentId || null;
    const siblings = itemsByParent.get(parent);
    if (siblings) siblings.push(entry);
    else itemsByParent.set(parent, [entry]);
  }
  const compare =
    mode === 'protocol'
      ? (left: ManagedSite, right: ManagedSite) =>
          String(left.kind === 'local' ? 'local' : left.protocol).localeCompare(
            String(right.kind === 'local' ? 'local' : right.protocol),
          ) || left.name.localeCompare(right.name)
      : (left: ManagedSite, right: ManagedSite) => left.name.localeCompare(right.name);
  const sorted = folders.sort(compare);
  // Walk the growing output to preserve grouping even for restored parent chains.
  // Each bucket is consumed once, so malformed cycles cannot grow the result forever.
  for (const entry of sorted) {
    const children = itemsByParent.get(entry.id);
    if (!children) continue;
    itemsByParent.delete(entry.id);
    for (const child of children.sort(compare)) sorted.push(child);
  }
  for (const entry of (itemsByParent.get(null) ?? []).sort(compare)) sorted.push(entry);
  return sorted;
}
