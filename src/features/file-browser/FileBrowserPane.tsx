import { memo, useMemo } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import FilePane from './FilePane.tsx';
import PaneConnectEmptyState from './components/PaneConnectEmptyState.tsx';
import PaneSourceSwitcher from './components/PaneSourceSwitcher.tsx';
import PaneToolbar from './components/PaneToolbar.tsx';
import { otherPaneId } from './panes/paneModel.ts';
import type { ConnectionForm, PaneId, PaneState } from './panes/paneModel.ts';
import type { FileEntry, ManagedSite } from '../../shared/types.ts';
import type { FileSearchHandle } from './components/useFileSearch.ts';
import type { DroppedFile } from './components/useFileDragDrop.ts';
import type { PathCrumb } from './components/PathBar.tsx';
import type { MenuItem } from '../../components/MenuItems.tsx';
import type { ShortcutOverrides } from '../../shortcuts/resolve.ts';
import type { OpenWithTarget } from '../open-with/index.ts';
import { isColumnKey } from './components/fileListModel.ts';
import { useDateFormatter } from '../settings/index.ts';
import type { ColumnKey } from './components/fileListModel.ts';

// Typed as ColumnKey rather than string so a name that COLUMN_DEFS does not
// define fails to compile here instead of rendering `undefined.render(...)`.
const LOCAL_COLUMNS: readonly ColumnKey[] = ['size', 'modifiedAt', 'createdAt', 'type'];
const REMOTE_COLUMNS: readonly ColumnKey[] = [
  'size',
  'modifiedAt',
  'type',
  'permissions',
  'owner',
  'group',
];

export interface PaneColumnsModel {
  local: Record<PaneId, string[]>;
  remote: Record<PaneId, string[]>;
  localWidths: Record<PaneId, Record<string, number>>;
  remoteWidths: Record<PaneId, Record<string, number>>;
  changeLocal: (id: PaneId) => (columns: string[]) => unknown;
  changeRemote: (id: PaneId) => (columns: string[]) => unknown;
  changeLocalWidths: (id: PaneId) => (widths: Record<string, number>) => unknown;
  changeRemoteWidths: (id: PaneId) => (widths: Record<string, number>) => unknown;
}

export interface PaneActionsModel {
  switchToLocal: (id: PaneId) => unknown;
  startConnect: (id: PaneId) => unknown;
  setForm: (id: PaneId, form: ConnectionForm) => unknown;
  connect: (id: PaneId) => () => unknown;
  disconnect: (id: PaneId) => unknown;
  cancelConnect: (id: PaneId) => unknown;
  connectSite: (id: PaneId, site: ManagedSite) => unknown;
  activate: (id: PaneId) => unknown;
  saveSite: (id: PaneId) => () => unknown;
  openSiteManager: (id: PaneId) => unknown;
  openLocalPathManager: (id: PaneId) => unknown;
  openSavedLocalPath?: (id: PaneId, site: ManagedSite) => unknown;
  crumbsFor: (pane: PaneState) => PathCrumb[];
  navigate: (id: PaneId, path: string) => unknown;
  openDirectory: (id: PaneId, name: string) => unknown;
  openDriveMenu: (id: PaneId) => (event: ReactMouseEvent<HTMLSpanElement>) => unknown;
  updatePane: (id: PaneId, patch: Partial<PaneState>) => unknown;
  join: (pane: PaneState, name: string) => string;
  openLocalPath: (path: string) => unknown;
  openRemoteFile: (target: OpenWithTarget) => unknown;
  dropFiles: (
    id: PaneId,
    pane: PaneState,
    files: DroppedFile[],
    targetFolder: string | null,
  ) => unknown;
  rename: (id: PaneId, entry: FileEntry, newName: string) => unknown;
  deleteSelected: (id: PaneId, tabId?: string, permanent?: boolean) => unknown;
  moveTo: (id: PaneId, pane: PaneState, folderOrder: string[]) => unknown;
  buildMenu: (
    id: PaneId,
  ) => (
    entry: FileEntry | null,
    options: { permanent: boolean; folderOrder: string[] },
  ) => MenuItem[];
  canCopyBetween: (source: PaneState, target: PaneState) => boolean;
  goHome: (
    id: PaneId,
    pane: PaneState,
    disconnected: boolean,
    sites: readonly ManagedSite[],
  ) => unknown;
  goBack: (id: PaneId) => unknown;
  goForward: (id: PaneId) => unknown;
  goUp: (id: PaneId) => unknown;
  chooseLocalDir: (id: PaneId) => () => unknown;
  newFolder: (id: PaneId) => unknown;
  newFile: (id: PaneId) => unknown;
  copySelected: (id: PaneId, pane: PaneState, otherId: PaneId, otherPane: PaneState) => unknown;
  copyToClipboard: (id: PaneId, pane: PaneState) => unknown;
  cutToClipboard: (id: PaneId, pane: PaneState) => unknown;
  canPaste: (pane: PaneState) => boolean;
  pasteClipboard: (id: PaneId, pane: PaneState) => unknown;
}

export interface FileBrowserPaneModel {
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  searchInputRef?: MutableRefObject<FileSearchHandle | null> | null | undefined;
  orderedSites: readonly ManagedSite[];
  localPaths?: readonly ManagedSite[] | undefined;
  sites: readonly ManagedSite[];
  columns: PaneColumnsModel;
  actions: PaneActionsModel;
  dragMoveStart: (
    side: PaneId,
    names: string[],
    entry: FileEntry,
    event: ReactMouseEvent<HTMLElement>,
  ) => unknown;
  outboundDragRef: MutableRefObject<boolean>;
  showHiddenFiles: boolean;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
  paneOrientation: 'horizontal' | 'vertical';
}

interface FileBrowserPaneProps {
  id: PaneId;
  style?: CSSProperties;
  model: FileBrowserPaneModel;
}

function FileBrowserPane({ id, style, model }: FileBrowserPaneProps) {
  const { t } = useTranslation();
  const {
    panes,
    activeTabId,
    searchInputRef,
    orderedSites,
    localPaths = [],
    sites,
    columns,
    actions,
    dragMoveStart,
    outboundDragRef,
    showHiddenFiles,
    keyboardShortcuts,
    paneOrientation,
  } = model;
  const formatDate = useDateFormatter();
  const pane = panes[id];
  const otherId = otherPaneId(id);
  const otherPane = panes[otherId];
  const availableColumns = pane.kind === 'local' ? LOCAL_COLUMNS : REMOTE_COLUMNS;
  // The persisted list is plain strings — settings written by another build can
  // name a column this one does not have — so it is narrowed here, once, rather
  // than trusted all the way down to COLUMN_DEFS.
  const persistedColumns = (pane.kind === 'local' ? columns.local : columns.remote)[id];
  const visibleColumns = useMemo(() => persistedColumns.filter(isColumnKey), [persistedColumns]);
  const columnWidths = (pane.kind === 'local' ? columns.localWidths : columns.remoteWidths)[id];
  const disconnected = pane.kind === 'remote' && pane.status !== 'connected';
  const entries = useMemo(
    () =>
      showHiddenFiles
        ? pane.entries
        : pane.entries.filter((entry) => !entry.isHidden && !entry.name.startsWith('.')),
    [pane.entries, showHiddenFiles],
  );

  return (
    <FilePane
      key={`${activeTabId}:${id}`}
      side={id}
      kind={pane.kind}
      style={style}
      updatedAt={pane.refreshedAt}
      disconnected={disconnected}
      onActivate={() => actions.activate(id)}
      searchInputRef={searchInputRef}
      titleSlot={
        <PaneSourceSwitcher
          pane={pane}
          orderedSites={orderedSites}
          localPaths={localPaths}
          updatedAt={pane.refreshedAt}
          formatDate={formatDate}
          onSwitchLocal={() => actions.switchToLocal(id)}
          onStartConnect={() => actions.startConnect(id)}
          onFormChange={(form) => actions.setForm(id, form)}
          onDismissError={() => actions.updatePane(id, { errorMessage: '' })}
          onConnect={actions.connect(id)}
          onDisconnect={() => actions.disconnect(id)}
          onCancelConnect={() => actions.cancelConnect(id)}
          onSiteConnect={(site) => actions.connectSite(id, site)}
          onLocalPathOpen={(site) => actions.openSavedLocalPath?.(id, site)}
          onSaveSite={actions.saveSite(id)}
          onOpenSiteManager={() => actions.openSiteManager(id)}
          onOpenLocalPathManager={() => actions.openLocalPathManager(id)}
        />
      }
      crumbs={actions.crumbsFor(pane)}
      entries={entries}
      selectedNames={pane.selected}
      onCrumbClick={(path) => actions.navigate(id, path)}
      onDriveMenuOpen={pane.kind === 'local' ? actions.openDriveMenu(id) : undefined}
      onSelectionChange={(selected) => actions.updatePane(id, { selected })}
      onRowDoubleClick={(entry) => {
        if (entry.isDirectory) {
          actions.openDirectory(id, entry.name);
        } else if (pane.kind === 'local') {
          actions.openLocalPath(actions.join(pane, entry.name));
        } else {
          if (!pane.connectionId) return;
          actions.openRemoteFile({
            path: actions.join(pane, entry.name),
            size: entry.size,
            connectionId: pane.connectionId,
            paneId: id,
            tabId: activeTabId,
          });
        }
      }}
      onDropFiles={
        pane.kind === 'remote'
          ? (files, targetFolder) => actions.dropFiles(id, pane, files, targetFolder)
          : undefined
      }
      dragMoveStart={dragMoveStart}
      outboundDragRef={outboundDragRef}
      onRename={(entry, newName) => actions.rename(id, entry, newName)}
      onDeleteSelected={({ permanent = false } = {}) =>
        actions.deleteSelected(id, activeTabId, permanent)
      }
      onNavigateUp={disconnected ? undefined : () => actions.goUp(id)}
      onNavigateBack={disconnected ? undefined : () => actions.goBack(id)}
      onNavigateForward={disconnected ? undefined : () => actions.goForward(id)}
      onNavigateHome={() => actions.goHome(id, pane, disconnected, sites)}
      onMoveTo={(folderOrder) => actions.moveTo(id, pane, folderOrder)}
      onNewFolder={disconnected ? undefined : () => actions.newFolder(id)}
      onNewFile={disconnected ? undefined : () => actions.newFile(id)}
      onCopyToOtherPane={
        actions.canCopyBetween(pane, otherPane)
          ? () => actions.copySelected(id, pane, otherId, otherPane)
          : undefined
      }
      onCopySelection={() => actions.copyToClipboard(id, pane)}
      onCutSelection={() => actions.cutToClipboard(id, pane)}
      onPaste={actions.canPaste(pane) ? () => actions.pasteClipboard(id, pane) : undefined}
      onPathSubmit={(path) =>
        actions.navigate(id, pane.kind === 'remote' && !path.startsWith('/') ? `/${path}` : path)
      }
      getContextMenuItems={actions.buildMenu(id)}
      keyboardShortcuts={keyboardShortcuts}
      availableColumns={availableColumns}
      visibleColumns={visibleColumns}
      onVisibleColumnsChange={(pane.kind === 'local' ? columns.changeLocal : columns.changeRemote)(
        id,
      )}
      columnWidths={columnWidths}
      onColumnWidthsChange={(pane.kind === 'local'
        ? columns.changeLocalWidths
        : columns.changeRemoteWidths)(id)}
      loading={pane.loading}
      emptyMessage={
        pane.kind === 'remote' ? (
          disconnected ? (
            <PaneConnectEmptyState
              sites={sites}
              orderedSites={orderedSites}
              onSiteConnect={(site) => actions.connectSite(id, site)}
              onOpenSiteManager={() => actions.openSiteManager(id)}
            />
          ) : (
            t('filePane.emptyFolder')
          )
        ) : undefined
      }
      emptyScrollable={pane.kind === 'remote' && disconnected}
      toolbar={
        <PaneToolbar
          isLocal={pane.kind === 'local'}
          disconnected={disconnected}
          homeLabel={t('filePane.homeFolder')}
          canGoBack={pane.history.length > 0}
          canGoForward={pane.future.length > 0}
          hasSelection={pane.selected.size > 0}
          copyDisabled={!actions.canCopyBetween(pane, otherPane) || pane.selected.size === 0}
          copyLabel={
            paneOrientation === 'vertical'
              ? id === 'a'
                ? t('filePane.copyToPaneBelow')
                : t('filePane.copyToPaneAbove')
              : id === 'a'
                ? t('filePane.copyToPaneRight')
                : t('filePane.copyToPaneLeft')
          }
          onHome={() => actions.goHome(id, pane, disconnected, sites)}
          onBack={() => actions.goBack(id)}
          onForward={() => actions.goForward(id)}
          onUp={() => actions.goUp(id)}
          onChooseFolder={pane.kind === 'local' ? actions.chooseLocalDir(id) : undefined}
          onNewFolder={() => actions.newFolder(id)}
          onNewFile={() => actions.newFile(id)}
          onDelete={() => actions.deleteSelected(id)}
          onCopy={() => actions.copySelected(id, pane, otherId, otherPane)}
        />
      }
    />
  );
}

export default memo(FileBrowserPane);
