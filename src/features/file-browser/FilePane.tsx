import { hostPlatform } from '../../platform/os.ts';
import { getInterfaceScale } from '../../platform/interfaceScale.ts';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import type { FileEntry } from '../../shared/paneContracts.ts';
import type { PaneId, PaneKind } from './panes/paneModel.ts';
import { getDoubleClickMs } from './doubleClick.ts';
import { preloadExtensions } from '../open-with/index.ts';
import { useDragSession } from '../../hooks/resize/useDragSession.ts';

/** Matches `.section-resizer` (6px) and `.section-panel-header` (28px) in CSS. */
const TERMINAL_RESIZER_HEIGHT = 6;
const TERMINAL_HEADER_HEIGHT = 28;
/** Small click-deadzone before dragging out of collapsed or maximized edges. */
const TERMINAL_DRAG_DEADZONE_PX = 4;

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
  /** Names held by a cut, shown paler until they are pasted. */
  cutNames?: ReadonlySet<string> | undefined;
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
  onPaste?: ((options?: { move?: boolean }) => unknown) | undefined;
  onPathSubmit?: ((path: string) => unknown) | undefined;
  getContextMenuItems?: (
    entry: FileEntry | null,
    options: {
      permanent: boolean;
      folderOrder: string[];
      /** Starts renaming the entry in place; the menu decides where Rename goes. */
      rename?: (() => unknown) | undefined;
    },
  ) => MenuItem[];
  availableColumns: readonly ColumnKey[];
  visibleColumns: readonly ColumnKey[];
  onVisibleColumnsChange?: ((columns: string[]) => void) | undefined;
  columnWidths: Record<string, number>;
  onColumnWidthsChange?: ((widths: Record<string, number>) => void) | undefined;
  searchInputRef?: MutableRefObject<FileSearchHandle | null> | null | undefined;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
  terminalSlot?: ReactNode | undefined;
  terminalMode?: 'closed' | 'split' | 'collapsed' | 'maximized' | undefined;
  terminalSplitRatio?: number | undefined;
  onTerminalSplitChange?: ((ratio: number) => void) | undefined;
  onTerminalSplitCommit?: ((ratio: number) => void) | undefined;
  onTerminalSplitReset?: (() => void) | undefined;
  onTerminalModeChange?: ((mode: 'split' | 'collapsed' | 'maximized') => void) | undefined;
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
  cutNames,
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
  terminalSlot,
  terminalMode = 'closed',
  terminalSplitRatio = 0.5,
  onTerminalSplitChange,
  onTerminalSplitCommit,
  onTerminalSplitReset,
  onTerminalModeChange,
}: FilePaneProps) {
  const splitAreaRef = useRef<HTMLDivElement | null>(null);
  const [resizingTerminal, setResizingTerminal] = useState(false);
  const latestTerminalRatioRef = useRef(terminalSplitRatio);
  latestTerminalRatioRef.current = terminalSplitRatio;
  const preDragRatioRef = useRef(terminalSplitRatio);
  const dragModeRef = useRef<'split' | 'collapsed' | 'maximized'>('split');
  const dragStartYRef = useRef(0);
  const dragMovedRef = useRef(false);
  const onTerminalSplitChangeRef = useRef(onTerminalSplitChange);
  onTerminalSplitChangeRef.current = onTerminalSplitChange;
  const onTerminalSplitCommitRef = useRef(onTerminalSplitCommit);
  onTerminalSplitCommitRef.current = onTerminalSplitCommit;
  const onTerminalModeChangeRef = useRef(onTerminalModeChange);
  onTerminalModeChangeRef.current = onTerminalModeChange;

  useDragSession({
    active: resizingTerminal,
    cursor: 'row-resize',
    createHandlers: () => ({
      onMove: ({ clientY, scale }) => {
        if (!splitAreaRef.current) return;
        const domRect = splitAreaRef.current.getBoundingClientRect();
        const top = domRect.top / scale;
        const height = domRect.height / scale;
        const usable = height - TERMINAL_RESIZER_HEIGHT;
        if (usable <= 0) return;

        const filesPx = clientY - top - TERMINAL_RESIZER_HEIGHT / 2;
        const terminalPx = top + height - clientY - TERMINAL_RESIZER_HEIGHT / 2;
        const pastDeadzone =
          dragMovedRef.current ||
          Math.abs(clientY - dragStartYRef.current) >= TERMINAL_DRAG_DEADZONE_PX;

        if (dragModeRef.current === 'collapsed') {
          if (!pastDeadzone || terminalPx <= TERMINAL_HEADER_HEIGHT) return;
          dragMovedRef.current = true;
          dragModeRef.current = 'split';
          onTerminalModeChangeRef.current?.('split');
        } else if (dragModeRef.current === 'maximized') {
          if (!pastDeadzone || filesPx <= 0) return;
          dragMovedRef.current = true;
          dragModeRef.current = 'split';
          onTerminalModeChangeRef.current?.('split');
        } else {
          dragMovedRef.current = true;
        }

        if (filesPx <= 0) {
          dragModeRef.current = 'maximized';
          onTerminalModeChangeRef.current?.('maximized');
          return;
        }
        if (terminalPx <= TERMINAL_HEADER_HEIGHT) {
          dragModeRef.current = 'collapsed';
          onTerminalModeChangeRef.current?.('collapsed');
          return;
        }

        const nextTerminalRatio = Math.min(0.99, Math.max(0.01, terminalPx / usable));
        latestTerminalRatioRef.current = nextTerminalRatio;
        onTerminalSplitChangeRef.current?.(nextTerminalRatio);
      },
      onEnd: () => {
        setResizingTerminal(false);
        if (dragModeRef.current === 'split') {
          if (dragMovedRef.current) {
            onTerminalSplitCommitRef.current?.(latestTerminalRatioRef.current);
          }
        } else if (latestTerminalRatioRef.current !== preDragRatioRef.current) {
          latestTerminalRatioRef.current = preDragRatioRef.current;
          onTerminalSplitChangeRef.current?.(preDragRatioRef.current);
        }
      },
    }),
    dependencies: [],
  });
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
  const prevTerminalModeRef = useRef(terminalMode);
  // Collapsing or closing the terminal hides/unmounts xterm's focused textarea;
  // keep focus inside the pane so `.pane:focus-within` stays active.
  useLayoutEffect(() => {
    const prevMode = prevTerminalModeRef.current;
    prevTerminalModeRef.current = terminalMode;
    const lostTerminalSurface =
      (prevMode !== 'closed' && terminalMode === 'closed') ||
      ((prevMode === 'split' || prevMode === 'maximized') && terminalMode === 'collapsed');
    if (!lostTerminalSurface) return;
    const active = document.activeElement;
    const focusedHiddenBody =
      terminalMode === 'collapsed' &&
      active instanceof Element &&
      paneRef.current?.contains(active) &&
      active.closest('.terminal-panel-body') !== null;
    const lostFocusToDocument =
      !active || active === document.body || active === document.documentElement;
    if (focusedHiddenBody || lostFocusToDocument) {
      paneRef.current?.focus({ preventScroll: true });
    }
  }, [terminalMode]);
  const wasRenamingRef = useRef(false);
  const renameScrollRef = useRef<{ top: number; left: number } | null>(null);
  const snapshotRenameScroll = useCallback(() => {
    if (renameScrollRef.current) return;
    const list = paneRef.current?.querySelector<HTMLElement>('.pane-list');
    if (list) renameScrollRef.current = { top: list.scrollTop, left: list.scrollLeft };
  }, []);
  useLayoutEffect(() => {
    const wasRenaming = wasRenamingRef.current;
    wasRenamingRef.current = !!rename.renamingName;
    if (!wasRenaming || rename.renamingName) return;
    const saved = renameScrollRef.current;
    renameScrollRef.current = null;
    paneRef.current?.focus({ preventScroll: true });
    if (!saved) return;
    const restore = () => {
      const list = paneRef.current?.querySelector<HTMLElement>('.pane-list');
      if (!list) return;
      if (list.scrollTop !== saved.top) list.scrollTop = saved.top;
      if (list.scrollLeft !== saved.left) list.scrollLeft = saved.left;
    };
    restore();
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [rename.renamingName]);
  useEffect(() => {
    preloadExtensions(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name));
  }, [entries]);
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
  const { dragOver, dragRejected, dragOverRowName, handleRowMouseDown } = dragDrop;

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
    t,
  });
  const { openFiles } = contextMenu;

  const isVirtualized = shouldVirtualize(sorted.length);
  const { viewportRef, rowProbeRef, listRef, viewportSize, rowHeight } =
    useVirtualizedFileList(isVirtualized);
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
    folder: currentFullPath,
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
      if (last && last.name === entry.name && now - last.time <= getDoubleClickMs()) {
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

  const renderRow = (entry: FileEntry, index: number, style?: CSSProperties) => {
    const renameEditor =
      rename.renamingName === entry.name ? (
        <input
          className="rename-input"
          autoFocus
          value={rename.value}
          // Like Explorer: the name is selected without its extension.
          onFocus={(e) => {
            const dot = entry.isDirectory ? -1 : e.target.value.lastIndexOf('.');
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => rename.setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              snapshotRenameScroll();
              rename.commit(entry);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              snapshotRenameScroll();
              rename.cancel();
            }
          }}
          onBlur={() => {
            snapshotRenameScroll();
            rename.commit(entry);
          }}
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
        cut={!!cutNames?.has(entry.name)}
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
  } ${dragOver ? (dragRejected ? 'drag-wash-invalid' : 'drag-wash') : ''}`;

  const activeRowId =
    activeIndexRef.current != null ? `file-row-${side}-${activeIndexRef.current}` : undefined;

  return (
    <div
      ref={paneRef}
      className={`pane ${terminalMode === 'maximized' ? 'has-maximized-terminal-pane' : ''}`}
      data-side={side}
      data-disconnected={disconnected || undefined}
      onDragOver={dragDrop.handleDragOver}
      onDragLeave={dragDrop.handleDragLeave}
      onDrop={dragDrop.handleDrop}
      data-column-reorder-scope
      style={paneStyle}
      tabIndex={0}
      // The pane a dialog hands focus back to when what opened it is gone.
      onFocusCapture={(event) => {
        if (event.currentTarget.hasAttribute('data-focus-home')) return;
        for (const other of document.querySelectorAll('[data-focus-home]'))
          other.removeAttribute('data-focus-home');
        event.currentTarget.setAttribute('data-focus-home', '');
      }}
      onKeyDown={handlePaneKeyDown}
      onMouseDownCapture={onActivate}
      aria-activedescendant={activeRowId}
    >
      <div
        ref={dragDrop.ghostRef}
        className={`drag-move-ghost ${dragDrop.showGhost && !dragDrop.dragRejected ? 'active' : ''}`}
      >
        <span className="mode">{t('dragMove.modeCopy')}</span>
      </div>
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
        keyboardShortcuts={keyboardShortcuts}
      />

      {!disconnected && (
        <PathBar
          kind={kind}
          dragOverPath={dragDrop.dragOverPath}
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
      <div
        ref={splitAreaRef}
        className={`pane-split-area ${terminalSlot ? `has-terminal terminal-${terminalMode}` : ''}`}
      >
        <div
          className="pane-body"
          style={
            terminalSlot && terminalMode === 'split'
              ? { flex: `${1 - terminalSplitRatio} 1 0%` }
              : undefined
          }
          // Scroll does not bubble; capturing it here serves the plain and the
          // virtualized list alike, and the header follows the rows sideways.
          onScrollCapture={(event) => {
            const list = event.target as HTMLElement;
            if (!list.classList.contains('pane-list')) return;
            const header = event.currentTarget.querySelector<HTMLElement>('.row-header');
            if (header) header.scrollLeft = list.scrollLeft;
          }}
        >
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
              onClick: (e) => {
                if (hostPlatform() === 'macos' && e.ctrlKey && !e.metaKey && e.button === 0) {
                  contextMenu.openFiles(e, null);
                }
              },
              onContextMenu: (e) => contextMenu.openFiles(e, null),
            }}
            loading={loading}
            disconnected={disconnected}
            filterText={filterText}
            emptyMessage={emptyMessage}
            gridTemplateColumns={rowGridTemplateColumns}
            t={t}
          />

          {/* Named over the blurred list while a drag hovers a pane that cannot
            take it — a Server pane with no session. Always mounted and shown
            by CSS off the same class that blurs the list, so a drag from
            Explorer and one between panes answer alike without either path
            knowing this element is here. */}
          <div className="pane-drop-refusal" aria-hidden="true">
            <span>{t('filePane.connectFirst')}</span>
          </div>
        </div>

        {terminalSlot && (
          <>
            <div
              className={`section-resizer terminal-resizer ${resizingTerminal ? 'dragging' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                paneRef.current?.focus({ preventScroll: true });
                preDragRatioRef.current = terminalSplitRatio;
                dragModeRef.current =
                  terminalMode === 'collapsed' || terminalMode === 'maximized'
                    ? terminalMode
                    : 'split';
                dragStartYRef.current = event.clientY / getInterfaceScale();
                dragMovedRef.current = false;
                setResizingTerminal(true);
              }}
              onDoubleClick={
                terminalMode === 'collapsed' || terminalMode === 'maximized'
                  ? () => onTerminalModeChange?.('split')
                  : onTerminalSplitReset
              }
              data-tooltip={t('terminal.resize')}
            />
            <div
              key="terminal-slot"
              className={`pane-terminal-slot is-${terminalMode}`}
              style={terminalMode === 'split' ? { flex: `${terminalSplitRatio} 1 0%` } : undefined}
            >
              {terminalSlot}
            </div>
          </>
        )}
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
