import type { ManagedSite, SiteContainers } from '../../shared/types.ts';

export const FOLDERS = '__folders__';
export const ROOT = '__root__';

export interface VisibleSiteEntry {
  id: string;
  kind: 'site' | 'folder';
}

export function computeVisibleSiteOrder(
  containers: SiteContainers,
  expandedFolderIds: ReadonlySet<string>,
): VisibleSiteEntry[] {
  const order: VisibleSiteEntry[] = [];
  for (const folderId of containers[FOLDERS]) {
    order.push({ id: folderId, kind: 'folder' });
    if (expandedFolderIds.has(folderId)) {
      for (const childId of containers[folderId] || []) {
        order.push({ id: childId, kind: 'site' });
      }
    }
  }
  for (const siteId of containers[ROOT]) {
    order.push({ id: siteId, kind: 'site' });
  }
  return order;
}

export function resolveVisibleSiteFocus(
  visibleEntries: readonly VisibleSiteEntry[],
  focusedId: string | null,
  parentId?: string | null,
): string | null {
  if (focusedId && visibleEntries.some((entry) => entry.id === focusedId)) return focusedId;
  if (parentId && visibleEntries.some((entry) => entry.id === parentId)) return parentId;
  return visibleEntries[0]?.id ?? null;
}

export function buildSiteContainers(entries: readonly ManagedSite[]): SiteContainers {
  const folderIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'folder') folderIds.add(entry.id);
  }
  const folders: string[] = [];
  const root: string[] = [];
  const byFolder = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind === 'folder') {
      folders.push(entry.id);
      if (!byFolder.has(entry.id)) byFolder.set(entry.id, []);
    } else if (entry.parentId && folderIds.has(entry.parentId)) {
      if (!byFolder.has(entry.parentId)) byFolder.set(entry.parentId, []);
      byFolder.get(entry.parentId)!.push(entry.id);
    } else {
      root.push(entry.id);
    }
  }
  const containers: SiteContainers = { [FOLDERS]: folders, [ROOT]: root };
  for (const [folderId, ids] of byFolder) containers[folderId] = ids;
  return containers;
}

export function siteContainersMatch(left: SiteContainers, right: SiteContainers): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftItems = left[key] || [];
    const rightItems = right[key] || [];
    if (leftItems.length !== rightItems.length) return false;
    if (leftItems.some((id, index) => id !== rightItems[index])) return false;
  }
  return true;
}

export function findSiteContainer(id: string, containers: SiteContainers): string | undefined {
  for (const [key, items] of Object.entries(containers)) {
    if (key !== FOLDERS && items.includes(id)) return key;
  }
  return undefined;
}

export function moveSiteToContainerEnd(
  containers: SiteContainers,
  siteId: string,
  destination: string,
): SiteContainers {
  const source = findSiteContainer(siteId, containers);
  const sourceItems = source === undefined ? undefined : containers[source];
  const destinationItems = containers[destination];
  if (source === undefined || !sourceItems || !destinationItems) return containers;
  if (source === destination && sourceItems.at(-1) === siteId) return containers;

  const remaining = sourceItems.filter((id) => id !== siteId);
  const next = { ...containers, [source]: remaining };
  next[destination] = [...(source === destination ? remaining : destinationItems), siteId];
  return next;
}

export function moveSiteRelative(
  containers: SiteContainers,
  siteId: string,
  destination: string,
  overId: string,
  insertAfter: boolean,
): SiteContainers {
  const source = findSiteContainer(siteId, containers);
  const sourceContainer = source === undefined ? undefined : containers[source];
  const destinationContainer = containers[destination];
  if (source === undefined || !sourceContainer || !destinationContainer) return containers;

  const sourceItems = sourceContainer.filter((id) => id !== siteId);
  const destinationItems =
    source === destination ? sourceItems : destinationContainer.filter((id) => id !== siteId);
  const overIndex = destinationItems.indexOf(overId);
  const insertIndex =
    overIndex === -1 ? destinationItems.length : overIndex + (insertAfter ? 1 : 0);
  destinationItems.splice(insertIndex, 0, siteId);
  const next = {
    ...containers,
    [source]: sourceItems,
    [destination]: destinationItems,
  };
  return siteContainersMatch(next, containers) ? containers : next;
}

export function flattenSiteContainers(containers: SiteContainers): string[] {
  return [
    ...containers[FOLDERS],
    ...containers[ROOT],
    ...containers[FOLDERS].flatMap((folderId) => containers[folderId] || []),
  ];
}
