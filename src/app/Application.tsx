import { useEffect, useMemo, useRef } from 'react';
import TitleBar from './TitleBar.tsx';
import MenuBar from '../components/MenuBar.tsx';
import ViewToolbar from './ViewToolbar.tsx';
import { rememberConnectionLabels, useTransfers } from '../features/transfers/index.ts';
import { useLogLines } from '../features/logs/index.ts';
import { useTranslation } from 'react-i18next';
import { useTooltip } from '../hooks/useTooltip.ts';
import {
  TabStrip,
  useFileClipboard,
  usePaneActions,
  usePanes,
} from '../features/file-browser/index.ts';
import type { FileSearchHandle } from '../features/file-browser/index.ts';
import { useOpenWithLifecycle } from '../features/open-with/index.ts';
import { useAppBootstrap } from './useAppBootstrap.ts';
import { useAppDialogs } from './useAppDialogs.ts';
import { useAppEffects } from './useAppEffects.ts';
import { useWorkspaceLayout } from './useWorkspaceLayout.ts';
import { useFileBrowserPaneModel } from './useFileBrowserPaneModel.tsx';
import AppBanners from './AppBanners.tsx';
import Workspace from './Workspace.tsx';
import { settingsValues, useSettings, useSettingsTransfer } from '../features/settings/index.ts';
import { useSites, useSiteSaveWorkflow } from '../features/sites/index.ts';
import AppDialogs from './AppDialogs.tsx';
import { useApplicationSettings } from './useApplicationSettings.ts';
import UpdateStatus from './UpdateStatus.tsx';
import { useUpdateBanner } from './useUpdateBanner.ts';
import { useResetLayout } from './useResetLayout.ts';
import {
  connectionVisualState,
  useApplicationError,
  useVaultUnlockRecovery,
} from './useApplicationController.ts';
import { useApplicationMenuCommands } from './useApplicationMenuCommands.ts';
import { buildApplicationWorkspaceModel } from './applicationWorkspaceModel.ts';
import { buildApplicationDialogsModel } from './applicationDialogsModel.ts';
import { handler } from '../shared/asyncFailure.ts';
import { api } from '../platform/api/index.ts';

export default function Application() {
  const { t } = useTranslation();

  const { errorMessage, setErrorMessage, reportError, dismissError } = useApplicationError();
  const dialogs = useAppDialogs();
  // Only the names Application itself reads; the whole object goes to the
  // dialogs model, so a new dialog does not need a line here.
  const {
    setShowSettings,
    setShowAbout,
    showSaveSite,
    setShowSaveSite,
    setShowSiteManagerDialog,
    setShowLocalPathManagerDialog,
    setShowExportSettings,
    setShowImportSettings,
    newFolderTarget,
    setNewFolderTarget,
    newFileTarget,
    setNewFileTarget,
    moveToTarget,
    setMoveToTarget,
    setChmodTarget,
    driveMenu,
    setDriveMenu,
    confirmState,
    vaultUnlockRetries,
    setVaultUnlockRetries,
    requestConfirm,
  } = dialogs;
  // Settings arrive grouped by owner; each consumer below takes the group it
  // is about rather than a handful of loose fields.
  const {
    settings,
    update: updateSettings,
    applySettings: applySettingsState,
    applySettingsDialogPatch,
    persistSettingsDialogPatch,
  } = useSettings();
  const { layout, logging } = settings;
  const { lines: logLines, clear: clearLogLines } = useLogLines();

  const searchInputARef = useRef<FileSearchHandle | null>(null);
  const searchInputBRef = useRef<FileSearchHandle | null>(null);
  const searchInputRefs = useMemo(() => ({ a: searchInputARef, b: searchInputBRef }), []);

  const {
    windowNarrow,
    effectivePaneOrientation,
    panesRef,
    splitRatio,
    resizing,
    startResize,
    resetSplitRatio,
    transferQueueHeight,
    logPanelHeight,
    transferManuallyResized,
    logManuallyResized,
    resizingSection,
    startSectionResize,
    resetSectionHeight,
    transferLogRef,
    transferLogSplitRatio,
    resizingTransferLog,
    startTransferLogResize,
    resetTransferLogSplitRatio,
    hydrateFromSettings: hydrateSectionResizeFromSettings,
    toggleLocalPane,
    toggleRemotePane,
    toggleTransferQueue,
    toggleHiddenFiles,
    toggleLog,
    toggleLogTimestamps,
    togglePaneOrientation,
  } = useWorkspaceLayout({ layout, logging, update: updateSettings });

  useTooltip();

  // Settings and theme

  const {
    applySettings,
    changeTheme,
    changeLocalColumns,
    changeRemoteColumns,
    changeLocalColumnWidths,
    changeRemoteColumnWidths,
    changeTransferColumnWidths,
    changeTransferColumnOrder,
  } = useApplicationSettings({
    layout,
    applySettings: applySettingsState,
    hydrateLayout: hydrateSectionResizeFromSettings,
    update: updateSettings,
  });

  const {
    sites,
    refreshSites,
    legacyPasswordNotice,
    setLegacyPasswordNotice,
    plaintextSecretNotice,
    setPlaintextSecretNotice,
    secretNotPersistedNotice,
    setSecretNotPersistedNotice,
  } = useAppBootstrap({ applySettings });

  useAppEffects({
    interface: settings.interface,
    vaultAutoLockMinutes: settings.security.vaultAutoLockMinutes,
    t,
  });

  // Saved sites

  // Panes and tabs

  const handleVaultUnlockRequired = useVaultUnlockRecovery(setVaultUnlockRetries);

  const {
    runUpload,
    retryTransfer,
    pauseTransfer,
    stopTransfer,
    stopTransfersForConnection,
    pauseAllTransfers,
    stopAllTransfers,
    resumeAllTransfers,
    retryAllTransfers,
    clearCompletedTransfers,
    copyEntries,
    handleOsDropFiles,
    hasCompletedTransfers,
    hasActiveTransfers,
    hasPausableTransfers,
    canResumeAllTransfers,
    activeTransfersCount,
    hasPausedTransfers,
    hasRetryableTransfers,
    transfersEmpty,
  } = useTransfers({
    setErrorMessage: reportError,
    overwriteAction: settings.transfers.overwriteAction,
    confirmOverwrite: (path) =>
      new Promise<boolean>((resolve) =>
        requestConfirm(t('confirm.overwriteSingleExists', { name: path }), () => resolve(true), {
          confirmLabel: t('confirm.overwriteLabel'),
          danger: true,
          onCancel: () => resolve(false),
        }),
      ),
  });

  const {
    tabs,
    activeTabId,
    setActiveTabId,
    panes,
    syncBrowsing,
    syncEligible,
    updatePane,
    updateTab,
    reorderTab,
    setPaneForm,
    paneJoin,
    crumbsFor,
    paneParent,
    refreshPane,
    navigatePane,
    openDirectory,
    goPaneBack,
    goPaneForward,
    refreshBothPanes,
    toggleSync,
    startPaneConnect,
    switchPaneToLocal,
    connectPane,
    disconnectPane,
    cancelConnectPane,
    siteConnectPane,
    connectSavedSite,
    recentSiteIds,
    openNewTab,
    closeTab,
    deletePaneSelected,
    deletePaneEntry,
    submitNewFolder,
    submitNewFile,
    renamePaneEntry,
    movePaneSamePane,
    chooseLocalDir,
    goPaneHome,
    confirmOverwriteIfNeeded,
    canCopyBetween,
    aggregateStatus,
    soleConnectedRemotePane,
    connectedRemotePanes,
    freeConnectTargetPaneId,
    openConnectionIds,
    connectionLabels,
    lastActivePaneId,
    activatePane,
  } = usePanes({
    reportError,
    setErrorMessage,
    requestConfirm,
    concurrency: settings.transfers.concurrency,
    connectTimeout: settings.connection.connectTimeout,
    paneOrientation: effectivePaneOrientation,
    overwriteAction: settings.transfers.overwriteAction,
    ftpActiveMode: settings.connection.ftpActiveMode,
    saveSessionOnExit: settings.connection.saveSessionOnExit,
    defaultLocalPath: settings.interface.defaultLocalPath,
    onVaultUnlockRequired: handler(handleVaultUnlockRequired),
    stopTransfersForConnection,
  });
  const routeConnectionLabels = useMemo(
    () =>
      new Map(
        tabs.flatMap((tab) =>
          (['a', 'b'] as const).flatMap((side) => {
            const pane = tab.panes[side];
            return pane.kind === 'remote' && pane.connectionId
              ? [
                  [
                    pane.connectionId,
                    pane.siteLabel ||
                      (pane.form.protocol === 'webdav' ? pane.form.webdavUrl : pane.form.host) ||
                      '?',
                  ] as const,
                ]
              : [];
          }),
        ),
      ),
    [tabs],
  );
  // Here rather than in the transfer list, which is not mounted while hidden:
  // a transfer should still name its server once that connection is closed.
  useEffect(() => rememberConnectionLabels(routeConnectionLabels), [routeConnectionLabels]);

  const {
    target: openWithTarget,
    setTarget: setOpenWithTarget,
    watches: openWithWatches,
    changedId: openWithChanged,
    setChangedId: setOpenWithChanged,
    registerOpened: handleOpenWithOpened,
  } = useOpenWithLifecycle(tabs);

  // These dialogs resolve against the active tab. Blocking tab commands while
  // one is open keeps that implicit target stable until the action completes.
  const modalOpen = !!(
    openWithTarget ||
    openWithChanged ||
    newFolderTarget ||
    newFileTarget ||
    moveToTarget ||
    showSaveSite ||
    vaultUnlockRetries.length > 0 ||
    confirmState
  );

  const {
    connectableSites: flatSites,
    orderedSites,
    localPaths,
    saveSite: handleSiteManagerSave,
    deleteSite: handleSiteDelete,
    saveFolder: handleSaveFolder,
    deleteFolder: handleDeleteFolder,
    applyLayout: handleApplyLayout,
  } = useSites({
    sites,
    recentSiteIds,
    refreshSites,
    reportError,
    onSecretNotPersisted: () => setSecretNotPersistedNotice(true),
  });

  const { exportSettings: handleExportSettings, importSettings: handleImportSettings } =
    useSettingsTransfer({ applySettings, refreshSites, reportError });

  const { handleSaveSite, saveFromPane: handleSaveSiteFromPane } = useSiteSaveWorkflow({
    panes,
    activeTabId,
    setShowSaveSite,
    saveSite: handleSiteManagerSave,
    updatePane,
  });

  const {
    status: updateStatus,
    checkForUpdates,
    installUpdate,
    downloadUpdate,
    banner: updateBanner,
  } = useUpdateBanner(settings.updates.autoCheckUpdates, hasActiveTransfers);

  const {
    copyToClipboard,
    cutToClipboard,
    canPaste,
    pasteClipboard,
    copySelectedWithConfirm,
    dragMove,
    outboundDragRef,
  } = useFileClipboard({
    confirmOverwriteIfNeeded,
    copyEntries,
    canCopyBetween,
    refreshPane,
    movePaneSamePane,
    panes,
  });

  const { buildPaneMenu, moveToFolders } = usePaneActions({
    t,
    keyboardShortcuts: settings.shortcuts.keyboardShortcuts,
    panes,
    activeTabId,
    paneJoin,
    navigatePane,
    refreshPane,
    canCopyBetween,
    confirmOverwriteIfNeeded,
    copyEntries,
    deletePaneSelected,
    deletePaneEntry,
    setNewFolderTarget,
    setNewFileTarget,
    setMoveToTarget,
    setChmodTarget,
    setOpenWithTarget,
  });

  const resetLayout = useResetLayout({
    confirm: requestConfirm,
    confirmMessage: t('confirm.resetLayout'),
    confirmLabel: t('common.reset'),
    reportError,
    hydrateLayout: hydrateSectionResizeFromSettings,
    update: updateSettings,
  });

  const menus = useApplicationMenuCommands({
    commands: {
      modalOpen,
      keyboardShortcuts: settings.shortcuts.keyboardShortcuts,
      searchLocal: () => searchInputRefs.a.current?.toggle(),
      searchRemote: () => searchInputRefs.b.current?.toggle(),
      toggleHiddenFiles,
      freeConnectTargetPaneId,
      startPaneConnect,
      refreshBothPanes,
      panes,
      handleSaveSite,
      setShowSettings,
      openNewTab,
      tabs,
      closeTab,
      activeTabId,
      setActiveTabId,
    },
    menu: {
      modalOpen,
      openNewTab,
      tabs,
      closeTab,
      activeTabId,
      freeConnectTargetPaneId,
      startPaneConnect,
      soleConnectedRemotePane,
      connectedRemotePanes,
      connectionLabels,
      disconnectPane,
      handleSaveSite,
      setShowExportSettings,
      setShowImportSettings,
      theme: settings.interface.theme,
      changeTheme,
      resetLayout,
      syncBrowsing,
      syncEligible,
      toggleSync,
      showHiddenFiles: layout.showHiddenFiles,
      toggleHiddenFiles,
      showLocalPane: layout.showLocalPane,
      toggleLocalPane,
      showRemotePane: layout.showRemotePane,
      toggleRemotePane,
      showTransferQueue: layout.showTransferQueue,
      toggleTransferQueue,
      logEnabled: logging.logEnabled,
      toggleLog,
      effectivePaneOrientation,
      windowNarrow,
      togglePaneOrientation,
      refreshBothPanes,
      panes,
      canCopyBetween,
      copySelectedWithConfirm,
      hasCompletedTransfers,
      clearCompletedTransfers,
      refreshPane,
      openSiteManager: () => setShowSiteManagerDialog(true),
      openLocalPathManager: () => setShowLocalPathManagerDialog(true),
      openSettings: () => setShowSettings(true),
      openAbout: () => setShowAbout(true),
      checkForUpdates,
      keyboardShortcuts: settings.shortcuts.keyboardShortcuts,
    },
  });

  // Pane view models

  const { renderPane } = useFileBrowserPaneModel({
    panes,
    activeTabId,
    searchInputRefs,
    orderedSites,
    localPaths,
    sites: flatSites,
    showHiddenFiles: layout.showHiddenFiles,
    keyboardShortcuts: settings.shortcuts.keyboardShortcuts,
    paneOrientation: effectivePaneOrientation,
    reportError,
    localColumns: layout.localColumns,
    remoteColumns: layout.remoteColumns,
    localColumnWidths: layout.localColumnWidths,
    remoteColumnWidths: layout.remoteColumnWidths,
    changeLocalColumns,
    changeRemoteColumns,
    changeLocalColumnWidths,
    changeRemoteColumnWidths,
    dragMoveStart: dragMove.startDrag,
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
    openSiteManager: (paneId) => setShowSiteManagerDialog(paneId),
    openLocalPathManager: (paneId) => setShowLocalPathManagerDialog(paneId),
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
  });

  const workspaceModel = buildApplicationWorkspaceModel({
    effectivePaneOrientation,
    showLocalPane: layout.showLocalPane,
    showRemotePane: layout.showRemotePane,
    panesRef,
    splitRatio,
    resizing,
    startResize,
    resetSplitRatio,
    renderPane,
    dragMove,
    transferLogLayout: {
      windowNarrow,
      showTransferQueue: layout.showTransferQueue,
      logEnabled: logging.logEnabled,
      resizingSection,
      startSectionResize,
      resetSectionHeight,
      transferLogRef,
      transferQueueHeight,
      logPanelHeight,
      transferManuallyResized,
      logManuallyResized,
      transferLogSplitRatio,
      resizingTransferLog,
      startTransferLogResize,
      resetTransferLogSplitRatio,
    },
    transfer: {
      empty: transfersEmpty,
      onRetry: (id) => retryTransfer(id, refreshBothPanes),
      onPause: handler(pauseTransfer),
      onStop: handler(stopTransfer),
      onClearCompleted: clearCompletedTransfers,
      connectionLabels: routeConnectionLabels,
      columnWidths: layout.transferColumnWidths,
      onColumnWidthsChange: changeTransferColumnWidths,
      columnOrder: layout.transferColumnOrder,
      onColumnOrderChange: changeTransferColumnOrder,
    },
    log: {
      empty: logLines.length === 0,
      lines: logLines,
      onClear: clearLogLines,
      activeConnectionIds: openConnectionIds,
      connectionLabels,
      showTimestamps: logging.logShowTimestamps,
      onToggleTimestamps: toggleLogTimestamps,
    },
    panes,
    status: {
      status: aggregateStatus,
      paneOrientation: effectivePaneOrientation,
      syncBrowsing,
      connectionVisualState: connectionVisualState(aggregateStatus, hasPausedTransfers),
      hasActiveTransfers,
      activeTransfersCount,
      hasPausedTransfers,
    },
  });

  const dialogsModel = buildApplicationDialogsModel({
    settings: {
      values: settingsValues(settings),
      preview: applySettingsDialogPatch,
      save: persistSettingsDialogPatch,
      export: handleExportSettings,
      import: handleImportSettings,
    },
    dialogs,
    updater: { status: updateStatus, check: checkForUpdates },
    siteActions: {
      sites,
      save: handleSiteManagerSave,
      saveFromPane: handleSaveSiteFromPane,
      delete: handleSiteDelete,
      saveFolder: handleSaveFolder,
      deleteFolder: handleDeleteFolder,
      applyLayout: handleApplyLayout,
      connect: connectSavedSite,
    },
    panes,
    activeTabId,
    tabs,
    paneActions: {
      submitNewFolder,
      submitNewFile,
      confirmOverwriteIfNeeded,
      movePaneSamePane,
    },
    openWith: {
      target: openWithTarget,
      setTarget: setOpenWithTarget,
      watches: openWithWatches,
      changedId: openWithChanged,
      setChangedId: setOpenWithChanged,
      registerOpened: handleOpenWithOpened,
    },
    openWithAssociations: settings.transfers.openWithAssociations,
    logLines,
    runUpload,
    refreshPane,
    windowNarrow,
    services: {
      exportDiagnostics: api.log.exportDiagnostics,
      chmod: api.session.chmod,
      paneJoin,
      reportError,
    },
  });

  return (
    <div className="app-shell">
      <TitleBar minimizeToTray={settings.interface.minimizeToTray} />
      <MenuBar menus={menus} />

      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={closeTab}
        onNew={openNewTab}
        onRename={(tabId, name) => updateTab(tabId, { name })}
        onReorder={reorderTab}
        sites={flatSites}
        colored={settings.interface.coloredTabs}
        disabled={modalOpen}
        lastActivePaneId={lastActivePaneId}
      />

      <ViewToolbar
        showLocalPane={layout.showLocalPane}
        toggleLocalPane={toggleLocalPane}
        showRemotePane={layout.showRemotePane}
        toggleRemotePane={toggleRemotePane}
        showTransferQueue={layout.showTransferQueue}
        toggleTransferQueue={toggleTransferQueue}
        logEnabled={logging.logEnabled}
        toggleLog={toggleLog}
        effectivePaneOrientation={effectivePaneOrientation}
        paneOrientation={layout.paneOrientation}
        windowNarrow={windowNarrow}
        togglePaneOrientation={togglePaneOrientation}
        hasActiveTransfers={hasActiveTransfers}
        hasPausedTransfers={hasPausedTransfers}
        hasPausableTransfers={hasPausableTransfers}
        canResumeAllTransfers={canResumeAllTransfers}
        pauseAllTransfers={pauseAllTransfers}
        resumeAllTransfers={resumeAllTransfers}
        hasRetryableTransfers={hasRetryableTransfers}
        stopAllTransfers={stopAllTransfers}
        retryAllTransfers={retryAllTransfers}
        refreshBothPanes={refreshBothPanes}
        keyboardShortcuts={settings.shortcuts.keyboardShortcuts}
      />

      <AppBanners
        errorMessage={errorMessage}
        onDismissError={dismissError}
        legacyPasswordNotice={legacyPasswordNotice}
        onDismissLegacyPasswordNotice={() => setLegacyPasswordNotice(false)}
        plaintextSecretNotice={plaintextSecretNotice}
        onDismissPlaintextSecretNotice={() => setPlaintextSecretNotice(false)}
        secretNotPersistedNotice={secretNotPersistedNotice}
        onDismissSecretNotPersistedNotice={() => setSecretNotPersistedNotice(false)}
      />

      <Workspace
        {...workspaceModel}
        statusBar={{
          ...workspaceModel.statusBar,
          update: (
            <UpdateStatus
              update={updateBanner}
              onInstall={handler(installUpdate)}
              onDownload={handler(downloadUpdate)}
            />
          ),
        }}
      />

      <AppDialogs model={dialogsModel} />
    </div>
  );
}
