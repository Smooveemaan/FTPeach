import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  Ref,
  MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import ContextMenu from '../../components/ContextMenu.tsx';
import Icon from '../../components/Icon.tsx';
import type { MenuItem } from '../../components/MenuItems.tsx';

import FileColumnHeader from './components/FileColumnHeader.tsx';
import FileList from './components/FileList.tsx';
import FileRow from './components/FileRow.tsx';
import PathBar from './components/PathBar.tsx';
import type { PathCrumb } from './components/PathBar.tsx';
import PaneTitleBar, { usePaneSourceMinWidth } from './components/PaneTitleBar.tsx';
import useRenameWorkflow from './components/useRenameWorkflow.ts';
import useFileSelection from './components/useFileSelection.ts';
import useFileSearch from './components/useFileSearch.ts';
import type { FileSearchHandle } from './components/useFileSearch.ts';
import useFileColumns from './components/useFileColumns.ts';
import useFileContextMenu from './components/useFileContextMenu.ts';
import useFileDragDrop from './components/useFileDragDrop.ts';
import type { DroppedFile } from './components/useFileDragDrop.ts';
import useVirtualizedFileList from './components/useVirtualizedFileList.ts';
import { shouldVirtualize } from './components/fileListModel.ts';
import type { ColumnKey } from './components/fileListModel.ts';
import useFilePaneKeyboard from './components/useFilePaneKeyboard.ts';
import useFilePaneSorting from './components/useFilePaneSorting.ts';
import type { ShortcutOverrides } from '../../shortcuts/resolve.ts';
import type { FileEntry } from '../../shared/types.ts';
import type { PaneId, PaneKind } from './panes/paneModel.ts';

export interface FilePaneProps {
  side: PaneId;
  kind: PaneKind;
  style?: CSSProperties | undefined;
  title?: ReactNode | undefined;
  titleSlot?: ReactElement<{ ref?: Ref<HTMLElement> }> | null | undefined;
  updatedAt?: string | number | Date | null | undefined;
  onActivate?: (() => unknown) | undefined;
  crumbs: readonly PathCrumb[];
  entries: readonly FileEntry[];
  selectedNames: ReadonlySet<string>;
  onCrumbClick: (path: string) => void;
  onDriveMenuOpen?: ((event: ReactMouseEvent<HTMLSpanElement>) => void) | undefined;
  onSelectionChange: (selectedNames: Set<string>) => void;
  onRowDoubleClick: (entry: FileEntry) => unknown;
  toolbar?: ReactNode | undefined;
  loading: boolean;
  emptyMessage?: ReactNode | undefined;
  emptyScrollable?: boolean | undefined;
  disconnected: boolean;
  onDropFiles?: ((files: DroppedFile[], targetFolder: string | null) => unknown) | undefined;
  dragMoveStart: (
    side: PaneId,
    names: string[],
    entry: FileEntry,
    event: ReactMouseEvent<HTMLElement>,
  ) => unknown;
  outboundDragRef: MutableRefObject<boolean>;
  onRename?: ((entry: FileEntry, newName: string) => unknown) | undefined;
  onDeleteSelected?: ((options?: { permanent?: boolean }) => unknown) | undefined;
  onNavigateUp?: (() => unknown) | undefined;
  onNavigateBack?: (() => unknown) | undefined;
  onNavigateForward?: (() => unknown) | undefined;
  onNavigateHome?: (() => unknown) | undefined;
  onMoveTo?: ((folderOrder: string[]) => unknown) | undefined;
  onNewFolder?: (() => unknown) | undefined;
  onNewFile?: (() => unknown) | undefined;
  onCopyToOtherPane?: (() => unknown) | undefined;
  onCopySelection?: (() => unknown) | undefined;
  onCutSelection?: (() => unknown) | undefined;
  onPaste?: (() => unknown) | undefined;
  onPathSubmit?: ((path: string) => unknown) | undefined;
  getContextMenuItems?: (
    entry: FileEntry | null,
    options: { permanent: boolean; folderOrder: string[] },
  ) => MenuItem[];
  availableColumns: readonly ColumnKey[];
  visibleColumns: readonly ColumnKey[];
  onVisibleColumnsChange?: ((columns: string[]) => void) | undefined;
  columnWidths: Record<string, number>;
  onColumnWidthsChange?: ((widths: Record<string, number>) => void) | undefined;
  searchInputRef?: MutableRefObject<FileSearchHandle | null> | null | undefined;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
}

function FilePane({
  side,
  kind,
  style,
  title,
  titleSlot,
  updatedAt,
  onActivate,
  crumbs,
  entries,
  selectedNames,
  onCrumbClick,
  onDriveMenuOpen,
  onSelectionChange,
  onRowDoubleClick,
  toolbar,
  loading,
  emptyMessage,
  emptyScrollable,
  disconnected,
  onDropFiles,
  dragMoveStart,
  outboundDragRef,
  onRename,
  onDeleteSelected,
  onNavigateUp,
  onNavigateBack,
  onNavigateForward,
  onNavigateHome,
  onMoveTo,
  onNewFolder,
  onNewFile,
  onCopyToOtherPane,
  onCopySelection,
  onCutSelection,
  onPaste,
  onPathSubmit,
  getContextMenuItems,
  availableColumns,
  visibleColumns,
  onVisibleColumnsChange,
  columnWidths,
  onColumnWidthsChange,
  searchInputRef,
  keyboardShortcuts,
}: FilePaneProps) {
  const { t } = useTranslation();
  const columnLabels = useMemo<Record<ColumnKey, string>>(
    () => ({
      size: t('filePane.columnSize'),
      modifiedAt: t('filePane.columnModifiedAt'),
      createdAt: t('filePane.columnCreatedAt'),
      type: t('filePane.columnType'),
      permissions: t('filePane.columnPermissions'),
      owner: t('filePane.columnOwner'),
      group: t('filePane.columnGroup'),
    }),
    [t],
  );
  const currentFullPath = crumbs.at(-1)?.path ?? '';
  const search = useFileSearch({ currentPath: currentFullPath, externalRef: searchInputRef });
  const { text: filterText } = search;
  const { sourceRef, paneStyle } = usePaneSourceMinWidth({ disconnected, style });
  const rename = useRenameWorkflow(onRename);
  const onRowDoubleClickRef = useRef(onRowDoubleClick);
  onRowDoubleClickRef.current = onRowDoubleClick;
  const handleRowDoubleClick = useCallback(
    (entry: FileEntry) => onRowDoubleClickRef.current(entry),
    [],
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const wasRenamingRef = useRef(false);
  useEffect(() => {
    if (wasRenamingRef.current && !rename.renamingName) paneRef.current?.focus();
    wasRenamingRef.current = !!rename.renamingName;
  }, [rename.renamingName]);
  const {
    nameAscExplicit,
    sortDir,
    sortKey,
    sortedEntries: sorted,
    sortedFolderNames,
    toggleSort,
  } = useFilePaneSorting({ entries, filterText, t });
  const {
    activeColumns,
    widthOf,
    gridTemplateColumns,
    rowGridTemplateColumns,
    draggedColumn,
    getDragHandleProps,
    suppressColumnClickRef,
    registerHeaderRef,
    nameHeaderRef,
    toggleColumn,
    resetColumnWidths,
    autoFitColumn,
    startColumnResize,
  } = useFileColumns({
    availableColumns,
    visibleColumns,
    onVisibleColumnsChange,
    columnWidths,
    onColumnWidthsChange,
    sortKey,
    sortDir,
    nameAscExplicit,
    rows: sorted,
    columnLabels,
    t,
  });
  const dragDrop = useFileDragDrop({
    side,
    sorted,
    selectedNames,
    dragMoveStart,
    onDropFiles,
    outboundDragRef,
  });
  const {
    dragOver,
    dragOverRowName,
    handleRowMouseDown,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = dragDrop;

  const contextMenu = useFileContextMenu({
    getContextMenuItems,
    folderOrder: sortedFolderNames,
    onRename,
    rename,
    availableColumns,
    visibleColumns,
    columnLabels,
    toggleColumn,
    resetColumnWidths,
    keyboardShortcuts,
    t,
  });
  const { openFiles } = contextMenu;

  const isVirtualized = shouldVirtualize(sorted.length);
  const virtualization = useVirtualizedFileList(isVirtualized);
  const { viewportRef, rowProbeRef, listRef, viewportSize, rowHeight } = virtualization;
  const {
    activeIndexRef,
    marqueeElRef,
    handleRowClick,
    selectForContextMenu,
    startMarquee,
    moveActive,
    jumpActive,
    toggleActive,
    handleTypeahead,
    clear: clearSelection,
  } = useFileSelection({
    entries,
    sorted,
    selectedNames,
    onSelectionChange,
    isVirtualized,
    listRef,
    side,
  });

  // Chromium/WebView2's native `dblclick` pairing can silently fail to fire
  // when both clicks land at the exact same screen coordinates (observed
  // reliably diving through nested folders that share a name and sit at the
  // same on-screen row — moving the mouse a pixel first "unsticks" it, which
  // is the signature of a stale hit-test/click-pairing cache rather than an
  // app bug). Detecting the double-click ourselves from plain `click` timing
  // sidesteps that entirely: it only depends on `click` firing, which it
  // reliably does.
  const DOUBLE_CLICK_MS = 500;
  const lastRowClickRef = useRef<{ name: string; time: number } | null>(null);
  const handleRowClickWithDoubleDetect = useCallback(
    (index: number, e: ReactMouseEvent<HTMLElement>) => {
      handleRowClick(index, e);
      const entry = sorted[index];
      if (!entry || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) {
        lastRowClickRef.current = null;
        return;
      }
      const now = performance.now();
      const last = lastRowClickRef.current;
      if (last && last.name === entry.name && now - last.time <= DOUBLE_CLICK_MS) {
        lastRowClickRef.current = null;
        handleRowDoubleClick(entry);
      } else {
        lastRowClickRef.current = { name: entry.name, time: now };
      }
    },
    [handleRowClick, sorted, handleRowDoubleClick],
  );
  const handleRowContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>, entry: FileEntry, index: number) => {
      selectForContextMenu(index);
      openFiles(e, entry);
    },
    [selectForContextMenu, openFiles],
  );

  const handlePaneKeyDown = useFilePaneKeyboard({
    entries,
    sortedEntries: sorted,
    sortedFolderNames,
    selectedNames,
    keyboardShortcuts,
    onSelectionChange,
    onStartRename: onRename ? rename.start : undefined,
    onDeleteSelected,
    onNavigateUp,
    onNavigateBack,
    onNavigateForward,
    onNavigateHome,
    onMoveTo,
    onNewFolder,
    onNewFile,
    onCopyToOtherPane,
    onCopySelection,
    onCutSelection,
    onPaste,
    onOpenEntry: handleRowDoubleClick,
    clearSelection,
    moveActive,
    jumpActive,
    toggleActive,
    handleTypeahead,
  });

  virtualization.extraRef.current = {
    side,
    filesAriaLabel: t('filePane.filesAriaLabel'),
    onPointerDown: startMarquee,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
    onContextMenu: (e) => contextMenu.openFiles(e, null),
  };

  const renderRow = (entry: FileEntry, index: number, style?: CSSProperties) => {
    const renameEditor =
      rename.renamingName === entry.name ? (
        <input
          className="rename-input"
          autoFocus
          value={rename.value}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => rename.setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') rename.commit(entry);
            if (e.key === 'Escape') rename.cancel();
          }}
          onBlur={() => rename.commit(entry)}
        />
      ) : null;
    return (
      <FileRow
        key={entry.name}
        entry={entry}
        index={index}
        side={side}
        style={style}
        selected={selectedNames.has(entry.name)}
        dragTarget={dragOverRowName === entry.name}
        gridTemplateColumns={rowGridTemplateColumns}
        nameWidth={widthOf('name')}
        activeColumns={activeColumns}
        t={t}
        onRowMouseDown={handleRowMouseDown}
        onRowClick={handleRowClickWithDoubleDetect}
        onRowContextMenu={handleRowContextMenu}
        rename={renameEditor}
      />
    );
  };

  const paneListClassName = `pane-list ${sorted.length === 0 ? 'pane-list-empty' : ''} ${
    emptyScrollable ? 'pane-list-empty-scrollable' : ''
  } ${dragOver ? 'drag-wash' : ''}`;

  const activeRowId =
    activeIndexRef.current != null ? `file-row-${side}-${activeIndexRef.current}` : undefined;

  return (
    <div
      ref={paneRef}
      className="pane"
      data-column-reorder-scope
      style={paneStyle}
      tabIndex={0}
      onKeyDown={handlePaneKeyDown}
      onMouseDownCapture={onActivate}
      aria-activedescendant={activeRowId}
    >
      <PaneTitleBar
        title={title}
        titleSlot={titleSlot}
        updatedAt={updatedAt}
        disconnected={disconnected}
        side={side}
        search={search}
        toolbar={toolbar}
        sourceRef={sourceRef}
        t={t}
      />

      {!disconnected && (
        <PathBar
          kind={kind}
          crumbs={crumbs}
          onCrumbClick={onCrumbClick}
          onDriveMenuOpen={onDriveMenuOpen}
          onPathSubmit={onPathSubmit}
        />
      )}

      {/* Wraps the column header + list together as one shrinkable unit —
          .pane's min-height covers only .pane-titlebar + .pane-path, so
          once a pane gets squeezed past that (see theme.css), this whole
          body (header row included) clips away instead of the header
          insisting on its own always-visible slot. */}
      <div className="pane-body">
        {!disconnected && (
          <FileColumnHeader
            activeColumns={activeColumns}
            autoFitColumn={autoFitColumn}
            registerHeaderRef={registerHeaderRef}
            getDragHandleProps={getDragHandleProps}
            columnLabels={columnLabels}
            draggedColumn={draggedColumn}
            gridTemplateColumns={gridTemplateColumns}
            nameAscExplicit={nameAscExplicit}
            nameHeaderRef={nameHeaderRef}
            reorderable={Boolean(onVisibleColumnsChange)}
            resizable={Boolean(onColumnWidthsChange)}
            sortDir={sortDir}
            sortKey={sortKey}
            startColumnResize={startColumnResize}
            suppressColumnClickRef={suppressColumnClickRef}
            t={t}
            toggleSort={toggleSort}
            onContextMenu={contextMenu.openColumns}
          />
        )}

        {/* Hidden always-mounted probe, never the empty/loading placeholder
            or a real entry — .row's height comes entirely from padding/font
            (single line, no wrapping), so one throwaway row is exactly as
            tall as any real one, and measuring it directly means the fixed
            itemSize below never has to hardcode a number that'd silently
            drift out of sync with a future CSS tweak. */}
        <div
          ref={rowProbeRef}
          aria-hidden="true"
          className="row"
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            top: -9999,
            left: -9999,
            width: 300,
            gridTemplateColumns: '20px 1fr',
          }}
        >
          <span className="icon">
            <Icon name="file" size={13} />
          </span>
          <span className="name">{t('filePane.rowProbeSample')}</span>
        </div>

        <FileList
          virtualized={isVirtualized}
          listRef={listRef}
          outerElementType={virtualization.outerElementType}
          viewportRef={viewportRef}
          viewportSize={viewportSize}
          rowHeight={rowHeight}
          entries={sorted}
          renderRow={renderRow}
          className={paneListClassName}
          listProps={{
            'data-side': side,
            role: 'listbox',
            'aria-multiselectable': 'true',
            'aria-label': t('filePane.filesAriaLabel'),
            onPointerDown: startMarquee,
            onDragOver: handleDragOver,
            onDragLeave: handleDragLeave,
            onDrop: handleDrop,
            onContextMenu: (e) => contextMenu.openFiles(e, null),
          }}
          loading={loading}
          disconnected={disconnected}
          filterText={filterText}
          emptyMessage={emptyMessage}
          t={t}
        />
      </div>

      {contextMenu.menu && (
        <ContextMenu
          x={contextMenu.menu.x}
          y={contextMenu.menu.y}
          items={contextMenu.menu.items}
          onClose={contextMenu.close}
        />
      )}

      {/* Hidden until startMarquee's own mousemove handler flips it on and
          starts positioning it directly — position:fixed means its
          left/top/width/height can just be raw viewport pixels straight off
          the two corner mouse events, with no scroll-offset math needed
          regardless of which pane-list variant (virtualized or not) the
          drag started in. */}
      <div ref={marqueeElRef} className="marquee-select" />
    </div>
  );
}

export default memo(FilePane);
