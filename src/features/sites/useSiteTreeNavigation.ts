import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ManagedSite, SiteContainers } from '../../shared/types.ts';
import { computeVisibleSiteOrder, resolveVisibleSiteFocus } from './siteDragModel.ts';
import type { SiteDeleteTarget } from './useSiteManagerDialogState.ts';

interface UseSiteTreeNavigationOptions {
  activeId: string | null;
  containers: SiteContainers;
  entriesById: Map<string, ManagedSite>;
  expandedFolderIds: Set<string>;
  onConnect: (site: ManagedSite) => void;
  onMoveEntry?:
    ((id: string, kind: string | undefined, delta: number) => void | Promise<void>) | undefined;
  onRequestDelete: (target: SiteDeleteTarget) => void;
  onStartRenameFolder: (folder: ManagedSite) => void;
  onEdit: (site: ManagedSite) => void;
  onToggleFolder: (id: string) => void;
}

export interface SiteTreeNavigationModel {
  focusedId: string | null;
  handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerFocusNode: (id: string) => (node: HTMLElement | null) => void;
  setFocusedId: Dispatch<SetStateAction<string | null>>;
}

export function useSiteTreeNavigation({
  activeId,
  containers,
  entriesById,
  expandedFolderIds,
  onConnect,
  onMoveEntry,
  onRequestDelete,
  onStartRenameFolder,
  onEdit,
  onToggleFolder,
}: UseSiteTreeNavigationOptions): SiteTreeNavigationModel {
  const rowNodesRef = useRef(new Map<string, HTMLElement>());
  const [focusedId, setFocusedId] = useState<string | null>(
    () => computeVisibleSiteOrder(containers, expandedFolderIds)[0]?.id ?? null,
  );

  useEffect(() => {
    const visible = computeVisibleSiteOrder(containers, expandedFolderIds);
    const nextFocusedId = resolveVisibleSiteFocus(
      visible,
      focusedId,
      focusedId ? entriesById.get(focusedId)?.parentId : null,
    );
    if (nextFocusedId !== focusedId) setFocusedId(nextFocusedId);
  }, [containers, expandedFolderIds, entriesById, focusedId]);

  const registerFocusNode =
    (id: string) =>
    (node: HTMLElement | null): void => {
      if (node) rowNodesRef.current.set(id, node);
      else rowNodesRef.current.delete(id);
    };

  const focusRowById = (id: string) => {
    rowNodesRef.current.get(id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (activeId != null || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('[role="treeitem"][data-row-id]');
    if (!row || event.target !== row) return;

    const id = row.dataset.rowId;
    const kind = row.dataset.kind;
    if (!id) return;
    const entry = entriesById.get(id);
    if (!entry) return;

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (onMoveEntry) void onMoveEntry(id, kind, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    const visible = computeVisibleSiteOrder(containers, expandedFolderIds);
    const index = visible.findIndex((candidate) => candidate.id === id);
    const rtl = document.documentElement.dir === 'rtl';
    const expandKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    const collapseKey = rtl ? 'ArrowRight' : 'ArrowLeft';

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = visible[index + 1];
      if (next) focusRowById(next.id);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = visible[index - 1];
      if (previous) focusRowById(previous.id);
    } else if (event.key === expandKey && kind === 'folder') {
      event.preventDefault();
      if (!expandedFolderIds.has(id)) onToggleFolder(id);
      else {
        const firstChildId = containers[id]?.[0];
        if (firstChildId) focusRowById(firstChildId);
      }
    } else if (event.key === collapseKey) {
      if (kind === 'folder' && expandedFolderIds.has(id)) {
        event.preventDefault();
        onToggleFolder(id);
      } else if (kind === 'site' && entry.parentId) {
        event.preventDefault();
        focusRowById(entry.parentId);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (kind === 'folder') onToggleFolder(id);
      else onConnect(entry);
    } else if (event.key === 'F2') {
      event.preventDefault();
      if (kind === 'folder') onStartRenameFolder(entry);
      else onEdit(entry);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onRequestDelete({ kind: kind === 'folder' ? 'folder' : 'site', id, name: entry.name });
    }
  };

  return {
    focusedId,
    handleKeyDown,
    registerFocusNode,
    setFocusedId,
  };
}
