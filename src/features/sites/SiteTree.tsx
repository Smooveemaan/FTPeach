import { useState } from 'react';
import type { MouseEvent } from 'react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import ContextMenu from '../../components/ContextMenu.tsx';
import type { MenuItem } from '../../components/MenuItems.tsx';
import Icon from '../../components/Icon.tsx';
import {
  RootDropZone,
  SiteTreeDragOverlay,
  SortableFolderRow,
  SortableSiteRow,
} from './components/SiteTreeRows.tsx';
import type { SiteTreeRowNodeRef } from './components/SiteTreeRows.tsx';
import { FOLDERS, ROOT } from './siteDragModel.ts';
import type { ManagedSite, Translate } from '../../shared/types.ts';
import type { SiteDeleteTarget } from './useSiteManagerDialogState.ts';
import type { useSiteDragController } from './useSiteDragController.ts';
import { useSiteTreeNavigation } from './useSiteTreeNavigation.ts';

type SiteDragController = ReturnType<typeof useSiteDragController>;
interface TreeContextMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface SiteTreeProps extends Pick<
  SiteDragController,
  | 'sensors'
  | 'collisionDetection'
  | 'modifiers'
  | 'activeId'
  | 'activeEntry'
  | 'activeRect'
  | 'canCollapseSource'
  | 'localEntries'
  | 'containers'
  | 'dragContentHeight'
  | 'entriesById'
  | 'dropTargetFolderId'
> {
  onDragStart: SiteDragController['handleDragStart'];
  onDragOver: SiteDragController['handleDragOver'];
  onDragEnd: SiteDragController['handleDragEnd'];
  onDragCancel: SiteDragController['handleDragCancel'];
  addingFolder: boolean;
  newFolderName: string;
  onNewFolderNameChange: (name: string) => void;
  onCommitAddFolder: () => void;
  onCancelAddFolder: () => void;
  expandedFolderIds: Set<string>;
  renamingFolderId: string | null;
  renameFolderName: string;
  renamingSiteId: string | null;
  renameSiteName: string;
  onRenameFolderNameChange: (name: string) => void;
  onCommitRenameFolder: (folder: ManagedSite) => void;
  onCancelRenameFolder: () => void;
  onRenameSiteNameChange: (name: string) => void;
  onCommitRenameSite: (site: ManagedSite) => void;
  onCancelRenameSite: () => void;
  onStartRenameSite: (site: ManagedSite) => void;
  onToggleFolder: (id: string) => void;
  onStartRenameFolder: (folder: ManagedSite) => void;
  onRequestDelete: (target: SiteDeleteTarget) => void;
  onConnect: (site: ManagedSite) => void;
  onEdit: (site: ManagedSite) => void;
  onDuplicate: (site: ManagedSite) => void;
  onCreateInFolder: (folderId: string) => void;
  onMoveEntry?:
    ((id: string, kind: string | undefined, delta: number) => void | Promise<void>) | undefined;
  reorderEnabled?: boolean;
  registerRowNode: (id: string) => SiteTreeRowNodeRef;
  t: Translate;
}

export default function SiteTree({
  sensors,
  collisionDetection,
  modifiers,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  activeId,
  activeEntry,
  activeRect,
  canCollapseSource,
  localEntries,
  addingFolder,
  newFolderName,
  onNewFolderNameChange,
  onCommitAddFolder,
  onCancelAddFolder,
  containers,
  dragContentHeight,
  entriesById,
  expandedFolderIds,
  renamingFolderId,
  renameFolderName,
  renamingSiteId,
  renameSiteName,
  dropTargetFolderId,
  onRenameFolderNameChange,
  onCommitRenameFolder,
  onCancelRenameFolder,
  onRenameSiteNameChange,
  onCommitRenameSite,
  onCancelRenameSite,
  onStartRenameSite,
  onToggleFolder,
  onStartRenameFolder,
  onRequestDelete,
  onConnect,
  onEdit,
  onDuplicate,
  onCreateInFolder,
  onMoveEntry,
  reorderEnabled = true,
  registerRowNode,
  t,
}: SiteTreeProps) {
  const [contextMenu, setContextMenu] = useState<TreeContextMenu | null>(null);
  const { focusedId, handleKeyDown, registerFocusNode, setFocusedId } = useSiteTreeNavigation({
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
  });

  const openContextMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const siteMenuItems = (site: ManagedSite): MenuItem[] => [
    { label: t('connectionBar.connectTooltip.connect'), onClick: () => onConnect(site) },
    { label: t('siteManagerDialog.titleEdit'), onClick: () => onEdit(site) },
    { label: t('siteManagerDialog.duplicate'), onClick: () => onDuplicate(site) },
    { label: t('filePane.rename'), onClick: () => onStartRenameSite(site) },
    { separator: true },
    {
      label: t('paneMenu.delete'),
      danger: true,
      onClick: () => onRequestDelete({ kind: 'site', id: site.id, name: site.name }),
    },
  ];

  const folderMenuItems = (folder: ManagedSite): MenuItem[] => [
    {
      label: t('siteManagerDialog.newBookmarkInFolder'),
      onClick: () => onCreateInFolder(folder.id),
    },
    { label: t('filePane.rename'), onClick: () => onStartRenameFolder(folder) },
    { separator: true },
    {
      label: t('paneMenu.delete'),
      danger: true,
      onClick: () => onRequestDelete({ kind: 'folder', id: folder.id, name: folder.name }),
    },
  ];

  const renderSiteRow = (site: ManagedSite, level = 1) => {
    const items = siteMenuItems(site);
    return (
      <SortableSiteRow
        key={site.id}
        site={site}
        level={level}
        t={t}
        onConnect={onConnect}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onRequestDelete={onRequestDelete}
        isRenaming={renamingSiteId === site.id}
        renameSiteName={renameSiteName}
        onRenameNameChange={onRenameSiteNameChange}
        onCommitRename={() => onCommitRenameSite(site)}
        onCancelRename={onCancelRenameSite}
        onContextMenu={(e) => openContextMenu(e, items)}
        isFocused={focusedId === site.id}
        onRowFocus={() => setFocusedId(site.id)}
        collapseDraggingSource={Boolean(dropTargetFolderId) && canCollapseSource}
        registerNode={registerRowNode(site.id)}
        focusRef={registerFocusNode(site.id)}
      />
    );
  };

  const renderFolderGroup = (folder: ManagedSite) => {
    const expanded = expandedFolderIds.has(folder.id);
    const isRenaming = renamingFolderId === folder.id;
    const childIds = containers[folder.id] || [];
    const items = folderMenuItems(folder);

    return (
      <SortableFolderRow
        key={folder.id}
        folder={folder}
        expanded={expanded}
        isRenaming={isRenaming}
        isDropTarget={dropTargetFolderId === folder.id}
        renameFolderName={renameFolderName}
        onRenameChange={onRenameFolderNameChange}
        onCommitRename={() => onCommitRenameFolder(folder)}
        onCancelRename={onCancelRenameFolder}
        onToggle={() => onToggleFolder(folder.id)}
        onCreateInFolder={onCreateInFolder}
        onStartRenameFolder={onStartRenameFolder}
        onRequestDelete={onRequestDelete}
        onContextMenu={(e) => openContextMenu(e, items)}
        isFocused={focusedId === folder.id}
        onRowFocus={() => setFocusedId(folder.id)}
        registerNode={registerRowNode(folder.id)}
        focusRef={registerFocusNode(folder.id)}
        t={t}
      >
        {expanded && (
          <SortableContext
            items={childIds}
            strategy={verticalListSortingStrategy}
            disabled={!reorderEnabled}
          >
            {childIds
              .map((id) => entriesById.get(id))
              .filter((site): site is ManagedSite => site != null)
              .map((site) => renderSiteRow(site, 2))}
          </SortableContext>
        )}
      </SortableFolderRow>
    );
  };

  return (
    <DndContext
      autoScroll={false}
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={modifiers}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className={`site-manage-list${activeId ? ' is-dragging' : ''}`}>
        <div
          className="site-manage-content"
          role="tree"
          aria-label={t('siteManagerDialog.titleList')}
          onKeyDown={handleKeyDown}
          style={dragContentHeight != null ? { minHeight: dragContentHeight } : undefined}
        >
          {localEntries.length === 0 && !addingFolder && (
            <div className="site-manager-empty">{t('siteManager.emptyList')}</div>
          )}
          {addingFolder && (
            <div className="site-manage-row is-folder">
              <span
                className="site-manage-chevron site-manage-chevron-placeholder"
                aria-hidden="true"
              >
                <Icon name="chevronRight" size={12} />
              </span>
              <Icon name="folder" size={14} />
              <input
                type="text"
                autoFocus
                className="folder-name-input"
                placeholder={t('siteManagerDialog.folderNamePlaceholder')}
                aria-label={t('siteManagerDialog.folderNamePlaceholder')}
                value={newFolderName}
                onChange={(e) => onNewFolderNameChange(e.target.value)}
                onBlur={onCommitAddFolder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') onCancelAddFolder();
                }}
              />
            </div>
          )}
          <SortableContext
            items={containers[FOLDERS]}
            strategy={verticalListSortingStrategy}
            disabled={!reorderEnabled}
          >
            {containers[FOLDERS].map((id) => entriesById.get(id))
              .filter((folder): folder is ManagedSite => folder != null)
              .map(renderFolderGroup)}
          </SortableContext>
          {containers[FOLDERS].length > 0 && <div className="site-manage-divider" />}
          <RootDropZone>
            <SortableContext
              items={containers[ROOT]}
              strategy={verticalListSortingStrategy}
              disabled={!reorderEnabled}
            >
              {containers[ROOT].map((id) => entriesById.get(id))
                .filter((site): site is ManagedSite => site != null)
                .map((site) => renderSiteRow(site, 1))}
            </SortableContext>
          </RootDropZone>
        </div>
      </div>
      <SiteTreeDragOverlay activeEntry={activeEntry} activeRect={activeRect} />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </DndContext>
  );
}
