import { memo, useMemo } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import FilePane from './FilePane.tsx';
import PaneConnectEmptyState from './components/PaneConnectEmptyState.tsx';
import PaneSourceSwitcher from './components/PaneSourceSwitcher.tsx';
import PaneToolbar from './components/PaneToolbar.tsx';
import { otherPaneId } from './panes/paneModel.ts';
import type { PaneId } from './panes/paneModel.ts';
import type { ManagedSite } from '../../shared/siteContracts.ts';
import type { FileSearchHandle } from './components/useFileSearch.ts';
import { isColumnKey } from './components/fileListModel.ts';
import { useDateFormatter } from '../settings/index.ts';
import type { SettingsState } from '../settings/index.ts';
import type { ColumnKey } from './components/fileListModel.ts';
import type { FileClipboardModel } from './useFileClipboard.ts';
import type { FileBrowserShell } from './usePaneActions.ts';
import { usePaneActions } from './usePaneActions.ts';
import type { PanesModel } from './usePanes.ts';

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

/** Saves a pane's column choice; `app/` persists it with the other settings. */
export interface PaneColumnChanges {
  changeLocalColumns: (id: PaneId) => (columns: string[]) => unknown;
  changeRemoteColumns: (id: PaneId) => (columns: string[]) => unknown;
  changeLocalColumnWidths: (id: PaneId) => (widths: Record<string, number>) => unknown;
  changeRemoteColumnWidths: (id: PaneId) => (widths: Record<string, number>) => unknown;
}

export interface FileBrowserPaneProps {
  id: PaneId;
  style?: CSSProperties;
  searchInputRef?: MutableRefObject<FileSearchHandle | null> | null | undefined;
  browser: PanesModel;
  clipboard: FileClipboardModel;
  sites: {
    connectableSites: readonly ManagedSite[];
    orderedSites: readonly ManagedSite[];
    localPaths: readonly ManagedSite[];
  };
  settings: {
    layout: Pick<
      SettingsState['layout'],
      | 'showHiddenFiles'
      | 'localColumns'
      | 'remoteColumns'
      | 'localColumnWidths'
      | 'remoteColumnWidths'
    >;
    shortcuts: Pick<SettingsState['shortcuts'], 'keyboardShortcuts'>;
  };
  columns: PaneColumnChanges;
  paneOrientation: 'horizontal' | 'vertical';
  shell: FileBrowserShell;
}

function FileBrowserPane({
  id,
  style,
  searchInputRef,
  browser,
  clipboard,
  sites,
  settings,
  columns,
  paneOrientation,
  shell,
}: FileBrowserPaneProps) {
  const { t } = useTranslation();
  const { layout } = settings;
  const { keyboardShortcuts } = settings.shortcuts;
  const actions = usePaneActions({
    t,
    keyboardShortcuts,
    browser,
    sites: sites.connectableSites,
    shell,
    fileClipboard: clipboard,
  });
  const formatDate = useDateFormatter();
  const { panes, activeTabId } = browser;
  const pane = panes[id];
  const otherId = otherPaneId(id);
  const otherPane = panes[otherId];
  const availableColumns = pane.kind === 'local' ? LOCAL_COLUMNS : REMOTE_COLUMNS;
  // The persisted list is plain strings — settings written by another build can
  // name a column this one does not have — so it is narrowed here, once, rather
  // than trusted all the way down to COLUMN_DEFS.
  const persistedColumns = (pane.kind === 'local' ? layout.localColumns : layout.remoteColumns)[id];
  const visibleColumns = useMemo(() => persistedColumns.filter(isColumnKey), [persistedColumns]);
  const columnWidths = (
    pane.kind === 'local' ? layout.localColumnWidths : layout.remoteColumnWidths
  )[id];
  const disconnected = pane.kind === 'remote' && pane.status !== 'connected';
  const showHiddenFiles = layout.showHiddenFiles;
  const entries = useMemo(
    () =>
      showHiddenFiles
        ? pane.entries
        : pane.entries.filter((entry) => !entry.isHidden && !entry.name.startsWith('.')),
    [pane.entries, showHiddenFiles],
  );
  const copySelected = () =>
    clipboard.copySelectedWithConfirm(
      pane,
      otherPane,
      () => browser.refreshPane(id, pane.path),
      () => browser.refreshPane(otherId, otherPane.path),
    );

  return (
    <FilePane
      key={`${activeTabId}:${id}`}
      side={id}
      kind={pane.kind}
      style={style}
      updatedAt={pane.refreshedAt}
      disconnected={disconnected}
      onActivate={() => browser.activatePane(id)}
      searchInputRef={searchInputRef}
      titleSlot={
        <PaneSourceSwitcher
          pane={pane}
          orderedSites={sites.orderedSites}
          localPaths={sites.localPaths}
          updatedAt={pane.refreshedAt}
          formatDate={formatDate}
          onSwitchLocal={() => browser.switchPaneToLocal(id)}
          onStartConnect={() => browser.startPaneConnect(id)}
          onFormChange={(form) => browser.setPaneForm(id, form)}
          onDismissError={() => browser.updatePane(id, { errorMessage: '' })}
          onConnect={actions.connect(id)}
          onDisconnect={() => browser.disconnectPane(id)}
          onCancelConnect={() => browser.cancelConnectPane(id)}
          onSiteConnect={(site) => browser.siteConnectPane(id, site)}
          onLocalPathOpen={(site) => browser.switchPaneToLocal(id, activeTabId, site.localPath)}
          onSaveSite={shell.saveSite(id)}
          onOpenSiteManager={() => shell.dialogs.setShowSiteManagerDialog(id)}
          onOpenLocalPathManager={() => shell.dialogs.setShowLocalPathManagerDialog(id)}
        />
      }
      crumbs={browser.crumbsFor(pane)}
      entries={entries}
      selectedNames={pane.selected}
      onCrumbClick={(path) => void browser.navigatePane(id, path)}
      onDriveMenuOpen={
        pane.kind === 'local' ? (event) => void actions.openDriveMenu(id)(event) : undefined
      }
      onSelectionChange={(selected) => browser.updatePane(id, { selected })}
      onRowDoubleClick={(entry) => {
        if (entry.isDirectory) {
          browser.openDirectory(id, entry.name);
        } else if (pane.kind === 'local') {
          void actions.openLocalFile(browser.paneJoin(pane, entry.name));
        } else {
          if (!pane.connectionId) return;
          shell.openWith.setTarget({
            path: browser.paneJoin(pane, entry.name),
            size: entry.size,
            connectionId: pane.connectionId,
            paneId: id,
            tabId: activeTabId,
          });
        }
      }}
      onDropFiles={
        // A local pane copies what the shell hands it and needs no session; a
        // Server pane has nowhere to put it until one exists.
        disconnected
          ? undefined
          : (files, targetFolder) => actions.dropFiles(id, files, targetFolder)
      }
      dragMoveStart={clipboard.dragMove.startDrag}
      outboundDragRef={clipboard.outboundDragRef}
      onRename={(entry, newName) => browser.renamePaneEntry(id, entry, newName)}
      onDeleteSelected={({ permanent = false } = {}) =>
        browser.deletePaneSelected(id, activeTabId, permanent)
      }
      onNavigateUp={disconnected ? undefined : () => browser.paneParent(id)}
      onNavigateBack={disconnected ? undefined : () => browser.goPaneBack(id)}
      onNavigateForward={disconnected ? undefined : () => browser.goPaneForward(id)}
      onNavigateHome={() => actions.goHome(id)}
      onMoveTo={(folderOrder) => actions.moveTo(id, folderOrder)}
      onNewFolder={disconnected ? undefined : () => shell.dialogs.setNewFolderTarget(id)}
      onNewFile={disconnected ? undefined : () => shell.dialogs.setNewFileTarget(id)}
      onCopyToOtherPane={browser.canCopyBetween(pane, otherPane) ? copySelected : undefined}
      onCopySelection={() => clipboard.copyToClipboard(id, pane)}
      onCutSelection={() => clipboard.cutToClipboard(id, pane)}
      cutNames={clipboard.cutNames(pane)}
      onPaste={clipboard.canPaste(pane) ? () => clipboard.pasteClipboard(id, pane) : undefined}
      onPathSubmit={(path) =>
        browser.navigatePane(
          id,
          pane.kind === 'remote' && !path.startsWith('/') ? `/${path}` : path,
        )
      }
      getContextMenuItems={actions.buildPaneMenu(id)}
      keyboardShortcuts={keyboardShortcuts}
      availableColumns={availableColumns}
      visibleColumns={visibleColumns}
      onVisibleColumnsChange={(pane.kind === 'local'
        ? columns.changeLocalColumns
        : columns.changeRemoteColumns)(id)}
      columnWidths={columnWidths}
      onColumnWidthsChange={(pane.kind === 'local'
        ? columns.changeLocalColumnWidths
        : columns.changeRemoteColumnWidths)(id)}
      loading={pane.loading}
      emptyMessage={
        pane.kind === 'remote' ? (
          disconnected ? (
            <PaneConnectEmptyState
              sites={sites.connectableSites}
              orderedSites={sites.orderedSites}
              onSiteConnect={(site) => browser.siteConnectPane(id, site)}
              onOpenSiteManager={() => shell.dialogs.setShowSiteManagerDialog(id)}
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
          copyDisabled={!browser.canCopyBetween(pane, otherPane) || pane.selected.size === 0}
          copyLabel={
            paneOrientation === 'vertical'
              ? id === 'a'
                ? t('filePane.copyToPaneBelow')
                : t('filePane.copyToPaneAbove')
              : id === 'a'
                ? t('filePane.copyToPaneRight')
                : t('filePane.copyToPaneLeft')
          }
          onHome={() => actions.goHome(id)}
          onBack={() => browser.goPaneBack(id)}
          onForward={() => browser.goPaneForward(id)}
          onUp={() => browser.paneParent(id)}
          onChooseFolder={pane.kind === 'local' ? browser.chooseLocalDir(id) : undefined}
          onNewFolder={() => shell.dialogs.setNewFolderTarget(id)}
          onNewFile={() => shell.dialogs.setNewFileTarget(id)}
          onDelete={() => browser.deletePaneSelected(id)}
          onCopy={copySelected}
        />
      }
    />
  );
}

export default memo(FileBrowserPane);
