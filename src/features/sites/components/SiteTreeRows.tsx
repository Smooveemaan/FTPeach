import type { MouseEvent, ReactNode } from 'react';
import { DragOverlay, useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Transform } from '@dnd-kit/utilities';
import Icon from '../../../components/Icon.tsx';
import type { IconName } from '../../../components/Icon.tsx';
import TruncatedText from '../../../components/TruncatedText.tsx';
import { isolate } from '../../../shared/bidi.ts';
import type { ManagedSite, Translate } from '../../../shared/types.ts';
import { siteMeta } from '../siteMeta.ts';
import { getInterfaceScale } from '../../../platform/interfaceScale.ts';
import { ROOT } from '../siteDragModel.ts';
import type { SiteDeleteTarget } from '../useSiteManagerDialogState.ts';

export type SiteTreeRowNodeRef = (node: HTMLElement | null) => void;

function localTransformStyle(transform: Transform | null, isDragging: boolean) {
  if (isDragging || !transform) return { transform: undefined };
  const scale = getInterfaceScale();
  const local = { ...transform, x: transform.x / scale, y: transform.y / scale };
  return { transform: CSS.Transform.toString(local) };
}

interface SiteTreeDragOverlayProps {
  activeEntry: ManagedSite | null | undefined;
  activeRect: { width: number; height: number } | null;
}

export function SiteTreeDragOverlay({ activeEntry, activeRect }: SiteTreeDragOverlayProps) {
  return (
    <DragOverlay dropAnimation={null}>
      {activeEntry?.kind === 'folder' ? (
        <div
          className="site-manage-folder-group site-manage-folder-overlay"
          style={activeRect ? { width: activeRect.width } : undefined}
        >
          <div className="site-manage-row site-manage-row-overlay is-folder">
            <span className="site-manage-chevron">
              <Icon
                name={document.documentElement.dir === 'rtl' ? 'chevronLeft' : 'chevronRight'}
                size={12}
              />
            </span>
            <Icon name="folder" size={14} />
            <div className="site-info">
              <div className="site-name">{activeEntry.name}</div>
            </div>
          </div>
        </div>
      ) : activeEntry ? (
        <div
          className="site-manage-row site-manage-row-overlay is-site"
          style={activeRect ? { width: activeRect.width, height: activeRect.height } : undefined}
        >
          <Icon
            name={(activeEntry.icon || 'bookmark') as IconName}
            size={14}
            color={activeEntry.color || undefined}
          />
          <div className="site-info">
            <div className="site-name">{activeEntry.name}</div>
          </div>
        </div>
      ) : null}
    </DragOverlay>
  );
}

export function RootDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: ROOT });
  return (
    <div ref={setNodeRef} className="site-manage-root-zone">
      {children}
    </div>
  );
}

interface SortableSiteRowProps {
  site: ManagedSite;
  level: number;
  t: Translate;
  onConnect: (site: ManagedSite) => void;
  onEdit: (site: ManagedSite) => void;
  onDuplicate: (site: ManagedSite) => void;
  onRequestDelete: (target: SiteDeleteTarget) => void;
  isRenaming: boolean;
  renameSiteName: string;
  onRenameNameChange: (name: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  isFocused: boolean;
  onRowFocus: () => void;
  collapseDraggingSource: boolean;
  registerNode: SiteTreeRowNodeRef;
  focusRef: SiteTreeRowNodeRef;
}

export function SortableSiteRow({
  site,
  level,
  t,
  onConnect,
  onEdit,
  onDuplicate,
  onRequestDelete,
  isRenaming,
  renameSiteName,
  onRenameNameChange,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  isFocused,
  onRowFocus,
  collapseDraggingSource,
  registerNode,
  focusRef,
}: SortableSiteRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: site.id,
      data: { kind: 'site' },
    });
  const setRefs = (node: HTMLElement | null) => {
    setNodeRef(node);
    setActivatorNodeRef(node);
    registerNode(node);
    focusRef(node);
  };
  const style = localTransformStyle(transform, isDragging);
  return (
    <div
      ref={setRefs}
      style={style}
      className={`site-manage-row is-site${isDragging ? ' dragging' : ''}${
        isDragging && collapseDraggingSource ? ' collapse-source' : ''
      }`}
      data-kind="site"
      {...attributes}
      {...listeners}
      role="treeitem"
      aria-level={level}
      tabIndex={isFocused ? 0 : -1}
      data-row-id={site.id}
      onFocus={onRowFocus}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest('button, input')) return;
        onConnect(site);
      }}
    >
      <Icon
        name={(site.icon || 'bookmark') as IconName}
        size={14}
        color={site.color || undefined}
      />
      {isRenaming ? (
        <input
          type="text"
          autoFocus
          className="folder-name-input"
          aria-label={t('filePane.rename')}
          value={renameSiteName}
          onChange={(e) => onRenameNameChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') onCancelRename();
          }}
        />
      ) : (
        <div className="site-info" data-tooltip={siteMeta(site)}>
          <TruncatedText as="div" className="site-name">
            <bdi>{site.name}</bdi>
          </TruncatedText>
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn"
        aria-label={t('connectionBar.connectTooltip.connect')}
        data-tooltip={t('connectionBar.connectTooltip.connect')}
        onClick={() => onConnect(site)}
      >
        <Icon name="play" size={12} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn"
        aria-label={t('siteManagerDialog.titleEdit')}
        data-tooltip={t('siteManagerDialog.titleEdit')}
        onClick={() => onEdit(site)}
      >
        <Icon name="pencil" size={12} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn"
        aria-label={t('siteManagerDialog.duplicate')}
        data-tooltip={t('siteManagerDialog.duplicate')}
        onClick={() => onDuplicate(site)}
      >
        <Icon name="copy" size={12} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn"
        aria-label={t('paneMenu.delete')}
        data-tooltip={t('paneMenu.delete')}
        onClick={() => onRequestDelete({ kind: 'site', id: site.id, name: site.name })}
      >
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}

interface SortableFolderRowProps {
  folder: ManagedSite;
  expanded: boolean;
  isRenaming: boolean;
  isDropTarget: boolean;
  renameFolderName: string;
  onRenameChange: (name: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onToggle: () => void;
  onCreateInFolder: (folderId: string) => void;
  onStartRenameFolder: (folder: ManagedSite) => void;
  onRequestDelete: (target: SiteDeleteTarget) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  isFocused: boolean;
  onRowFocus: () => void;
  registerNode: SiteTreeRowNodeRef;
  focusRef: SiteTreeRowNodeRef;
  t: Translate;
  children: ReactNode;
}

export function SortableFolderRow({
  folder,
  expanded,
  isRenaming,
  isDropTarget,
  renameFolderName,
  onRenameChange,
  onCommitRename,
  onCancelRename,
  onToggle,
  onCreateInFolder,
  onStartRenameFolder,
  onRequestDelete,
  onContextMenu,
  isFocused,
  onRowFocus,
  registerNode,
  focusRef,
  t,
  children,
}: SortableFolderRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: folder.id,
      data: { kind: 'folder' },
    });
  const setRefs = (node: HTMLElement | null) => {
    setNodeRef(node);
    registerNode(node);
    focusRef(node);
  };
  const style = localTransformStyle(transform, isDragging);
  const toggleLabelKey = expanded
    ? 'siteManagerDialog.collapseFolder'
    : 'siteManagerDialog.expandFolder';
  const toggleLabel = t(toggleLabelKey, { name: isolate(folder.name) });
  return (
    <div
      ref={setRefs}
      style={style}
      className={`site-manage-folder-group${isDragging ? ' dragging' : ''}`}
      {...attributes}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) listeners?.onKeyDown?.(event);
      }}
      role="treeitem"
      aria-label={folder.name}
      aria-level={1}
      aria-expanded={expanded}
      tabIndex={isFocused ? 0 : -1}
      data-row-id={folder.id}
      data-kind="folder"
      onFocus={onRowFocus}
      onContextMenu={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[role="treeitem"]') === event.currentTarget
        ) {
          onContextMenu(event);
        }
      }}
    >
      <div
        className={`site-manage-row is-folder${isDropTarget ? ' drop-target' : ''}`}
        ref={setActivatorNodeRef}
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button, input')) return;
          onToggle();
        }}
        {...listeners}
      >
        <button
          type="button"
          className="site-manage-chevron"
          aria-label={toggleLabel}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Icon
            name={
              expanded
                ? 'chevronDown'
                : document.documentElement.dir === 'rtl'
                  ? 'chevronLeft'
                  : 'chevronRight'
            }
            size={12}
          />
        </button>
        <Icon name="folder" size={14} />
        {isRenaming ? (
          <input
            type="text"
            autoFocus
            className="folder-name-input"
            aria-label={t('siteManagerDialog.folderNamePlaceholder')}
            value={renameFolderName}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') onCancelRename();
            }}
          />
        ) : (
          <div className="site-info">
            <TruncatedText as="div" className="site-name">
              <bdi>{folder.name}</bdi>
            </TruncatedText>
          </div>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon site-manage-row-btn"
          aria-label={t('siteManagerDialog.newBookmarkInFolder')}
          data-tooltip={t('siteManagerDialog.newBookmarkInFolder')}
          onClick={() => onCreateInFolder(folder.id)}
        >
          <Icon name="starPlus" size={12} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon site-manage-row-btn"
          aria-label={t('filePane.rename')}
          data-tooltip={t('filePane.rename')}
          onClick={() => onStartRenameFolder(folder)}
        >
          <Icon name="pencil" size={12} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon site-manage-row-btn"
          aria-label={t('paneMenu.delete')}
          data-tooltip={t('paneMenu.delete')}
          onClick={() => onRequestDelete({ kind: 'folder', id: folder.id, name: folder.name })}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
      {/* Hidden while this folder is the one being dragged, not just its
          header — otherwise the invisible (visibility:hidden) placeholder
          left behind in FOLDERS' list keeps every child's full height,
          leaving a blank gap the size of the whole expanded folder instead
          of a single row. */}
      {!isDragging && expanded && (
        <div className="site-manage-folder-children" role="group">
          {children}
        </div>
      )}
    </div>
  );
}
