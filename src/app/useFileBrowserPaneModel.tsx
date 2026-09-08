import type { CSSProperties, JSX, MutableRefObject, MouseEvent as ReactMouseEvent } from 'react';
import type {
  FileBrowserPaneModel,
  FileSearchHandle,
  PaneActionsModel,
  PaneColumnsModel,
  PaneState,
  useFileClipboard,
  usePaneActions,
  usePanes,
} from '../features/file-browser/index.ts';
import { FileBrowserPane } from '../features/file-browser/index.ts';
import type { useOpenWithLifecycle } from '../features/open-with/index.ts';
import type { ColumnWidths, SettingsState } from '../features/settings/index.ts';
import type { useSites } from '../features/sites/index.ts';
import type { useTransfers } from '../features/transfers/index.ts';
import { api } from '../platform/api/index.ts';
import { reportRejection } from '../shared/asyncFailure.ts';
import { commandResultError } from '../shared/errorMessages.ts';
import type { PaneId } from '../shared/types.ts';
import type { ShortcutOverrides } from '../shortcuts/resolve.ts';
import type { DriveMenu, useAppDialogs } from './useAppDialogs.ts';

interface FileBrowserPaneModelOptions {
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  searchInputRefs: Record<PaneId, MutableRefObject<FileSearchHandle | null>>;
  orderedSites: ReturnType<typeof useSites>['orderedSites'];
  localPaths: ReturnType<typeof useSites>['localPaths'];
  sites: ReturnType<typeof useSites>['connectableSites'];
  showHiddenFiles: boolean;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
  paneOrientation: 'horizontal' | 'vertical';
  reportError: (raw: unknown) => void;

  localColumns: SettingsState['layout']['localColumns'];
  remoteColumns: SettingsState['layout']['remoteColumns'];
  localColumnWidths: SettingsState['layout']['localColumnWidths'];
  remoteColumnWidths: SettingsState['layout']['remoteColumnWidths'];
  changeLocalColumns: (side: PaneId) => (next: string[]) => unknown;
  changeRemoteColumns: (side: PaneId) => (next: string[]) => unknown;
  changeLocalColumnWidths: (side: PaneId) => (next: ColumnWidths) => unknown;
  changeRemoteColumnWidths: (side: PaneId) => (next: ColumnWidths) => unknown;

  dragMoveStart: ReturnType<typeof useFileClipboard>['dragMove']['startDrag'];
  outboundDragRef: ReturnType<typeof useFileClipboard>['outboundDragRef'];
  copySelectedWithConfirm: ReturnType<typeof useFileClipboard>['copySelectedWithConfirm'];
  copyToClipboard: ReturnType<typeof useFileClipboard>['copyToClipboard'];
  cutToClipboard: ReturnType<typeof useFileClipboard>['cutToClipboard'];
  canPaste: ReturnType<typeof useFileClipboard>['canPaste'];
  pasteClipboard: ReturnType<typeof useFileClipboard>['pasteClipboard'];

  switchPaneToLocal: ReturnType<typeof usePanes>['switchPaneToLocal'];
  startPaneConnect: ReturnType<typeof usePanes>['startPaneConnect'];
  setPaneForm: ReturnType<typeof usePanes>['setPaneForm'];
  connectPane: ReturnType<typeof usePanes>['connectPane'];
  disconnectPane: ReturnType<typeof usePanes>['disconnectPane'];
  cancelConnectPane: ReturnType<typeof usePanes>['cancelConnectPane'];
  siteConnectPane: ReturnType<typeof usePanes>['siteConnectPane'];
  activatePane: ReturnType<typeof usePanes>['activatePane'];
  handleSaveSite: (id: PaneId) => () => unknown;
  openSiteManager: (id: PaneId) => unknown;
  openLocalPathManager: (id: PaneId) => unknown;
  crumbsFor: ReturnType<typeof usePanes>['crumbsFor'];
  navigatePane: ReturnType<typeof usePanes>['navigatePane'];
  openDirectory: ReturnType<typeof usePanes>['openDirectory'];
  updatePane: ReturnType<typeof usePanes>['updatePane'];
  paneJoin: ReturnType<typeof usePanes>['paneJoin'];
  setOpenWithTarget: ReturnType<typeof useOpenWithLifecycle>['setTarget'];
  confirmOverwriteIfNeeded: ReturnType<typeof usePanes>['confirmOverwriteIfNeeded'];
  handleOsDropFiles: ReturnType<typeof useTransfers>['handleOsDropFiles'];
  refreshPane: ReturnType<typeof usePanes>['refreshPane'];
  renamePaneEntry: ReturnType<typeof usePanes>['renamePaneEntry'];
  deletePaneSelected: ReturnType<typeof usePanes>['deletePaneSelected'];
  setMoveToTarget: ReturnType<typeof useAppDialogs>['setMoveToTarget'];
  moveToFolders: ReturnType<typeof usePaneActions>['moveToFolders'];
  buildPaneMenu: ReturnType<typeof usePaneActions>['buildPaneMenu'];
  canCopyBetween: ReturnType<typeof usePanes>['canCopyBetween'];
  goPaneHome: ReturnType<typeof usePanes>['goPaneHome'];
  goPaneBack: ReturnType<typeof usePanes>['goPaneBack'];
  goPaneForward: ReturnType<typeof usePanes>['goPaneForward'];
  paneParent: ReturnType<typeof usePanes>['paneParent'];
  chooseLocalDir: ReturnType<typeof usePanes>['chooseLocalDir'];
  setNewFolderTarget: ReturnType<typeof useAppDialogs>['setNewFolderTarget'];
  setNewFileTarget: ReturnType<typeof useAppDialogs>['setNewFileTarget'];

  driveMenu: DriveMenu | null;
  setDriveMenu: ReturnType<typeof useAppDialogs>['setDriveMenu'];
}

export interface FileBrowserPaneRenderer {
  renderPane: (id: PaneId, style: CSSProperties) => JSX.Element;
}

export function useFileBrowserPaneModel(
  options: FileBrowserPaneModelOptions,
): FileBrowserPaneRenderer {
  const {
    panes,
    activeTabId,
    searchInputRefs,
    orderedSites,
    localPaths,
    sites,
    showHiddenFiles,
    keyboardShortcuts,
    paneOrientation,
    reportError,
    localColumns,
    remoteColumns,
    localColumnWidths,
    remoteColumnWidths,
    changeLocalColumns,
    changeRemoteColumns,
    changeLocalColumnWidths,
    changeRemoteColumnWidths,
    dragMoveStart,
    outboundDragRef,
    copySelectedWithConfirm,
    copyToClipboard,
    cutToClipboard,
    canPaste,
    pasteClipboard,
    switchPaneToLocal,
    startPaneConnect,
    setPaneForm,
    connectPane,
    disconnectPane,
    cancelConnectPane,
    siteConnectPane,
    activatePane,
    handleSaveSite,
    openSiteManager,
    openLocalPathManager,
    crumbsFor,
    navigatePane,
    openDirectory,
    updatePane,
    paneJoin,
    setOpenWithTarget,
    confirmOverwriteIfNeeded,
    handleOsDropFiles,
    refreshPane,
    renamePaneEntry,
    deletePaneSelected,
    setMoveToTarget,
    moveToFolders,
    buildPaneMenu,
    canCopyBetween,
    goPaneHome,
    goPaneBack,
    goPaneForward,
    paneParent,
    chooseLocalDir,
    setNewFolderTarget,
    setNewFileTarget,
    driveMenu,
    setDriveMenu,
  } = options;

  const openDriveMenu = (id: PaneId) => async (e: ReactMouseEvent<HTMLElement>) => {
    if (driveMenu?.id === id) {
      setDriveMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const drives = await api.fsLocal.drives();
    const currentPath = (panes[id].path || '').toUpperCase();
    setDriveMenu({
      id,
      x: document.documentElement.dir === 'rtl' ? rect.right : rect.left,
      y: rect.bottom,
      items: drives.map((d) => ({
        label: d.label,
        checked: currentPath.startsWith(d.path.toUpperCase()),
        onClick: () => navigatePane(id, d.path),
      })),
    });
  };

  const columns: PaneColumnsModel = {
    local: localColumns,
    remote: remoteColumns,
    localWidths: localColumnWidths,
    remoteWidths: remoteColumnWidths,
    changeLocal: changeLocalColumns,
    changeRemote: changeRemoteColumns,
    changeLocalWidths: changeLocalColumnWidths,
    changeRemoteWidths: changeRemoteColumnWidths,
  };

  const actions: PaneActionsModel = {
    switchToLocal: switchPaneToLocal,
    startConnect: startPaneConnect,
    setForm: setPaneForm,
    connect: connectPane,
    disconnect: disconnectPane,
    cancelConnect: cancelConnectPane,
    connectSite: siteConnectPane,
    activate: activatePane,
    openSavedLocalPath: (paneId, site) => {
      switchPaneToLocal(paneId, activeTabId, site.localPath);
    },
    saveSite: handleSaveSite,
    openSiteManager,
    openLocalPathManager,
    crumbsFor,
    navigate: navigatePane,
    openDirectory,
    openDriveMenu,
    updatePane,
    join: paneJoin,
    openLocalPath: (path) => {
      const extension = path.split('.').pop()?.toLocaleLowerCase() ?? '';
      const executableExtensions = new Set([
        'exe',
        'com',
        'bat',
        'cmd',
        'ps1',
        'psm1',
        'psd1',
        'msi',
        'msp',
        'mst',
        'lnk',
        'url',
        'hta',
        'js',
        'jse',
        'vbs',
        'vbe',
        'wsf',
        'wsh',
        'scr',
        'cpl',
        'reg',
        'inf',
        'scf',
        'application',
        'appref-ms',
        'gadget',
        'jar',
        'chm',
        'iso',
      ]);
      const operation = executableExtensions.has(extension)
        ? api.fsLocal.executePath(path)
        : api.fsLocal.openDocument(path);
      return operation.then((result) => {
        if (!result.ok) reportError(commandResultError(result));
      });
    },
    openRemoteFile: setOpenWithTarget,
    dropFiles: (paneId, pane, files, targetFolder) =>
      confirmOverwriteIfNeeded(
        pane,
        targetFolder ?? undefined,
        files.map((file) => file.name),
        (names) =>
          handleOsDropFiles(
            pane,
            files.filter((file) => names.includes(file.name)),
            targetFolder,
            () => refreshPane(paneId, pane.path),
          ),
        files,
      ),
    rename: renamePaneEntry,
    deleteSelected: deletePaneSelected,
    moveTo: (paneId, pane, folderOrder) => {
      const names = [...pane.selected];
      const folders = moveToFolders(names, folderOrder);
      if (folders.length > 0) setMoveToTarget({ id: paneId, names, folders });
    },
    buildMenu: buildPaneMenu,
    canCopyBetween,
    goHome: (paneId, pane, disconnected, availableSites) => {
      if (pane.kind === 'local') {
        // Symmetrical with the remote branch below. This returns a promise the
        // caller discards (the action is typed `=> unknown`), so a failure to read
        // the home directory has to be reported here rather than ridden out on a
        // `return` that only ever short-circuited.
        reportRejection(goPaneHome(paneId)());
        return;
      }
      if (disconnected) return;
      const site = pane.siteId
        ? availableSites.find((candidate) => candidate.id === pane.siteId)
        : null;
      reportRejection(navigatePane(paneId, site?.remotePath || '/'));
    },
    goBack: goPaneBack,
    goForward: goPaneForward,
    goUp: paneParent,
    chooseLocalDir,
    newFolder: setNewFolderTarget,
    newFile: setNewFileTarget,
    copySelected: (paneId, pane, otherId, otherPane) =>
      copySelectedWithConfirm(
        pane,
        otherPane,
        () => refreshPane(paneId, pane.path),
        () => refreshPane(otherId, otherPane.path),
      ),
    copyToClipboard,
    cutToClipboard,
    canPaste,
    pasteClipboard,
  };

  const sharedModel: Omit<FileBrowserPaneModel, 'searchInputRef'> = {
    panes,
    activeTabId,
    orderedSites,
    localPaths,
    sites,
    columns,
    dragMoveStart,
    outboundDragRef,
    showHiddenFiles,
    keyboardShortcuts,
    paneOrientation,
    actions,
  };

  const renderPane = (id: PaneId, style: CSSProperties) => (
    <FileBrowserPane
      key={`${activeTabId}:${id}`}
      id={id}
      style={style}
      model={{ ...sharedModel, searchInputRef: searchInputRefs[id] }}
    />
  );

  return { renderPane };
}
