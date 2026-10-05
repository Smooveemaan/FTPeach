import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import TitleBar from './TitleBar.tsx';
import MenuBar from '../components/MenuBar.tsx';
import ViewToolbar from './ViewToolbar.tsx';
import { rememberConnectionLabels, useTransfers } from '../features/transfers/index.ts';
import { useLogLines, useRememberedConnectionLabels } from '../features/logs/index.ts';
import { useTranslation } from 'react-i18next';
import { useTooltip } from '../hooks/useTooltip.ts';
import {
  FileBrowserPane,
  TabStrip,
  useFileClipboard,
  usePanes,
} from '../features/file-browser/index.ts';
import type { FileBrowserShell, FileSearchHandle } from '../features/file-browser/index.ts';
import { useOpenWithLifecycle, useRecoveredEdits } from '../features/open-with/index.ts';
import { useAppBootstrap } from './useAppBootstrap.ts';
import { anyDialogOpen, useAppDialogs } from './useAppDialogs.ts';
import { useAppEffects } from './useAppEffects.ts';
import { useStatusNotice } from '../hooks/useStatusNotice.ts';
import { useWorkspaceLayout } from './useWorkspaceLayout.ts';
import AppBanners from './AppBanners.tsx';
import Workspace from './Workspace.tsx';
import {
  settingsValues,
  useLogTimeFormatter,
  useSettings,
  useSettingsTransfer,
} from '../features/settings/index.ts';
import { useSites, useSiteSaveWorkflow } from '../features/sites/index.ts';
import AppDialogs from './AppDialogs.tsx';
import { useApplicationSettings } from './useApplicationSettings.ts';
import UpdateStatus from './UpdateStatus.tsx';
import { useUpdateBanner } from './useUpdateBanner.ts';
import { useResetLayout } from './useResetLayout.ts';
import { useTrayBridge } from './tray/useTrayBridge.ts';
import { useVaultState } from './useVaultState.ts';
import QuitDialog from './quit/QuitDialog.tsx';
import { useQuitWhenIdle } from './quit/useQuitWhenIdle.ts';
import { connectionVisualState, useApplicationError } from './useApplicationController.ts';
import { useApplicationMenuCommands } from './useApplicationMenuCommands.ts';
import { buildApplicationWorkspaceModel } from './applicationWorkspaceModel.ts';
import { buildApplicationDialogsModel } from './applicationDialogsModel.ts';
import { handler, reportRejection } from '../shared/asyncFailure.ts';
import { api } from '../platform/api/index.ts';
import type { PaneId } from '../shared/paneContracts.ts';

export default function Application() {
  const { t } = useTranslation();

  const { errorMessage, setErrorMessage, reportError, withdrawError, dismissError } =
    useApplicationError();
  const dialogs = useAppDialogs();
  // Only the names Application itself reads; the whole object goes to the
  // dialogs model and the panes, so a new dialog does not need a line here.
  const {
    showSaveSite,
    setShowSaveSite,
    newFolderTarget,
    newFileTarget,
    moveToTarget,
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
    refreshProxyPasswordSet,
  } = useSettings();
  const { layout, logging } = settings;
  const { lines: logLines, clear: clearLogLines } = useLogLines(logging.logEnabled);
  const formatLogTime = useLogTimeFormatter();

  const searchInputARef = useRef<FileSearchHandle | null>(null);
  const searchInputBRef = useRef<FileSearchHandle | null>(null);
  const searchInputRefs = useMemo(() => ({ a: searchInputARef, b: searchInputBRef }), []);

  // The toggles go to the menu bar with the object; the rest is read here.
  const workspace = useWorkspaceLayout({ layout, logging, update: updateSettings });
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
    toggleLog,
    togglePaneOrientation,
  } = workspace;

  useTooltip();

  // Settings and theme

  // The pane columns and the theme go on with the object; the rest is read here.
  const applicationSettings = useApplicationSettings({
    layout,
    applySettings: applySettingsState,
    hydrateLayout: hydrateSectionResizeFromSettings,
    update: updateSettings,
  });
  const {
    applySettings,
    changeTransferColumnWidths,
    changeTransferColumnOrder,
    changeTransferHiddenColumns,
  } = applicationSettings;

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
  });

  // Panes and tabs

  const handleVaultUnlockRequired = useCallback(
    (retry: () => unknown) => setVaultUnlockRetries((previous) => [...previous, retry]),
    [setVaultUnlockRetries],
  );
  const vault = useVaultState();
  // Locked, the unlock dialog opens with nothing to retry; it asks Windows
  // Hello itself. Open, it locks at once.
  const toggleVault = () => {
    if (vault?.locked) handleVaultUnlockRequired(() => undefined);
    else reportRejection(api.vault.lock());
  };

  const transfers = useTransfers({
    setErrorMessage: reportError,
    withdrawErrorMessage: withdrawError,
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
    hasActiveTransfers,
    hasPausableTransfers,
    canResumeAllTransfers,
    activeTransfersCount,
    hasPausedTransfers,
    hasRetryableTransfers,
    transfersEmpty,
  } = transfers;

  const quitWhenIdle = useQuitWhenIdle({ hasActiveTransfers });

  // `connectTimeout` and `ftpActiveMode` come from the live settings on every
  // render: the settings dialog previews them before they are saved.
  const browser = usePanes({
    reportError,
    setErrorMessage,
    requestConfirm,
    connectTimeout: settings.connection.connectTimeout,
    paneOrientation: effectivePaneOrientation,
    overwriteAction: settings.transfers.overwriteAction,
    ftpActiveMode: settings.connection.ftpActiveMode,
    saveSessionOnExit: settings.connection.saveSessionOnExit,
    defaultLocalPath: settings.interface.defaultLocalPath,
    onVaultUnlockRequired: handler(handleVaultUnlockRequired),
    stopTransfersForConnection,
  });
  const { tabs, activeTabId, panes } = browser;
  const logConnectionLabels = useRememberedConnectionLabels(browser.connectionLabels);
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

  const openWith = useOpenWithLifecycle(tabs);
  const recoveredEdits = useRecoveredEdits();

  // These dialogs resolve against the active tab. Blocking tab commands while
  // one is open keeps that implicit target stable until the action completes.
  const tabDialogOpen = !!(
    openWith.target ||
    openWith.changed ||
    newFolderTarget ||
    newFileTarget ||
    moveToTarget ||
    showSaveSite ||
    vaultUnlockRetries.length > 0 ||
    confirmState ||
    quitWhenIdle.promptOpen
  );
  // Shortcuts and menu commands wait for any dialog, Settings, the bookmark
  // manager and the recovered-edits prompt included: they would act on the
  // panes behind it.
  const modalOpen = tabDialogOpen || anyDialogOpen(dialogs) || recoveredEdits.edits.length > 0;

  const savedSites = useSites({
    sites,
    recentSiteIds: browser.recentSiteIds,
    refreshSites,
    reportError,
    onSecretNotPersisted: () => setSecretNotPersistedNotice(true),
  });

  useTrayBridge({
    t,
    transfers: { activeTransfersCount, hasPausableTransfers, canResumeAllTransfers },
    pauseAllTransfers,
    resumeAllTransfers: () => resumeAllTransfers(browser.refreshBothPanes),
    quit: quitWhenIdle,
    settings: settings.transfers,
    updateTransfers: updateSettings.transfers,
    recentSites: savedSites.orderedSites,
    connectableSites: savedSites.connectableSites,
    connectSavedSite: browser.connectSavedSite,
    freeConnectTargetPaneId: browser.freeConnectTargetPaneId,
  });

  const [statusNotice, showStatusNotice] = useStatusNotice();
  const { exportSettings: handleExportSettings, importSettings: handleImportSettings } =
    useSettingsTransfer({ applySettings, refreshSites, reportError });

  const { handleSaveSite, saveFromPane: handleSaveSiteFromPane } = useSiteSaveWorkflow({
    panes,
    activeTabId,
    setShowSaveSite,
    saveSite: savedSites.saveSite,
    updatePane: browser.updatePane,
  });

  const {
    status: updateStatus,
    checkForUpdates: runUpdateCheck,
    installUpdate,
    downloadUpdate,
    banner: updateBanner,
  } = useUpdateBanner(settings.updates.autoCheckUpdates, hasActiveTransfers);
  // A check the user asked for says so when there is nothing new; the status
  // bar otherwise only speaks up about an update.
  const manualUpdateCheck = useRef(false);
  const checkForUpdates = () => {
    manualUpdateCheck.current = true;
    return runUpdateCheck();
  };
  useEffect(() => {
    if (!manualUpdateCheck.current || !updateStatus || updateStatus.state === 'checking') return;
    manualUpdateCheck.current = false;
    if (updateStatus.state === 'not-available')
      showStatusNotice({
        text: t('settings.updateStatus.notAvailable'),
        short: t('statusBar.upToDate'),
      });
  }, [updateStatus, showStatusNotice, t]);

  const clipboard = useFileClipboard({ browser, transfers });

  const [transferLayoutVersion, setTransferLayoutVersion] = useState(0);
  const resetLayout = useResetLayout({
    onReset: () => setTransferLayoutVersion((version) => version + 1),
    confirm: requestConfirm,
    confirmMessage: t('confirm.resetLayout'),
    confirmLabel: t('common.reset'),
    reportError,
    hydrateLayout: (resetSettings) => {
      hydrateSectionResizeFromSettings(resetSettings);
      // The transfer list and log come out as a double-click on their
      // dividers leaves them, narrow or not.
      resetSectionHeight('transfers')();
      resetSectionHeight('log')();
    },
    update: updateSettings,
  });

  const menus = useApplicationMenuCommands({
    modalOpen,
    settings,
    browser,
    clipboard,
    workspace,
    dialogs,
    transfers,
    applicationSettings,
    searchInputRefs,
    saveSite: handleSaveSite,
    quit: quitWhenIdle,
    resetLayout,
    checkForUpdates,
  });

  // What a pane cannot do inside the file browser: the dialogs, transfers and
  // error banner this shell owns.
  const paneShell: FileBrowserShell = {
    dialogs,
    transfers,
    openWith,
    saveSite: handleSaveSite,
    reportError,
  };
  const renderPane = (id: PaneId, style: CSSProperties) => (
    <FileBrowserPane
      key={`${activeTabId}:${id}`}
      id={id}
      style={style}
      searchInputRef={searchInputRefs[id]}
      browser={browser}
      clipboard={clipboard}
      sites={savedSites}
      settings={settings}
      columns={applicationSettings}
      paneOrientation={effectivePaneOrientation}
      shell={paneShell}
    />
  );

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
    dragMove: clipboard.dragMove,
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
      onRetry: (id) => retryTransfer(id, browser.refreshBothPanes),
      onPause: handler(pauseTransfer),
      onStop: handler(stopTransfer),
      onClearCompleted: clearCompletedTransfers,
      connectionLabels: routeConnectionLabels,
      columnWidths: layout.transferColumnWidths,
      onColumnWidthsChange: changeTransferColumnWidths,
      columnOrder: layout.transferColumnOrder,
      onColumnOrderChange: changeTransferColumnOrder,
      layoutVersion: transferLayoutVersion,
      hiddenColumns: layout.transferHiddenColumns,
      onHiddenColumnsChange: changeTransferHiddenColumns,
    },
    log: {
      empty: logLines.length === 0,
      lines: logLines,
      onClear: clearLogLines,
      activeConnectionIds: browser.openConnectionIds,
      connectionLabels: logConnectionLabels,
      showTimestamps: logging.logShowTimestamps,
      formatTime: formatLogTime,
    },
    panes,
    status: {
      status: browser.aggregateStatus,
      paneOrientation: effectivePaneOrientation,
      syncBrowsing: browser.syncBrowsing,
      connectionVisualState: connectionVisualState(
        browser.aggregateStatus,
        hasActiveTransfers,
        hasPausedTransfers,
      ),
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
      // A reset removes the secrets the site list and the proxy settings show
      // as saved; both flags are the backend's to tell.
      vaultReset: handler(() => Promise.all([refreshSites(), refreshProxyPasswordSet()])),
      export: handleExportSettings,
      import: handleImportSettings,
      notify: showStatusNotice,
    },
    dialogs,
    updater: { status: updateStatus, check: checkForUpdates },
    siteActions: {
      sites,
      save: savedSites.saveSite,
      saveFromPane: handleSaveSiteFromPane,
      delete: savedSites.deleteSite,
      saveFolder: savedSites.saveFolder,
      deleteFolder: savedSites.deleteFolder,
      applyLayout: savedSites.applyLayout,
      connect: browser.connectSavedSite,
    },
    panes,
    activeTabId,
    tabs,
    paneActions: {
      submitNewFolder: browser.submitNewFolder,
      submitNewFile: browser.submitNewFile,
      confirmOverwriteIfNeeded: browser.confirmOverwriteIfNeeded,
      movePaneSamePane: browser.movePaneSamePane,
    },
    openWith,
    recoveredEdits,
    openWithAssociations: settings.transfers.openWithAssociations,
    runUpload,
    refreshPane: browser.refreshPane,
    windowNarrow,
    services: {
      exportDiagnostics: api.log.exportDiagnostics,
      chmod: api.session.chmod,
      paneJoin: browser.paneJoin,
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
        onSelect={browser.setActiveTabId}
        onClose={browser.closeTab}
        onNew={browser.openNewTab}
        onRename={(tabId, name) => browser.updateTab(tabId, { name })}
        onReorder={browser.reorderTab}
        sites={savedSites.connectableSites}
        colored={settings.interface.coloredTabs}
        disabled={tabDialogOpen}
        lastActivePaneId={browser.lastActivePaneId}
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
        refreshBothPanes={browser.refreshBothPanes}
        keyboardShortcuts={settings.shortcuts.keyboardShortcuts}
        vault={vault}
        toggleVault={toggleVault}
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
          quitPending: quitWhenIdle.pending ? { onCancel: quitWhenIdle.cancel } : undefined,
          notice: statusNotice,
          narrow: windowNarrow,
        }}
      />

      <AppDialogs model={dialogsModel} />
      {quitWhenIdle.promptOpen && (
        <QuitDialog
          count={activeTransfersCount}
          unsyncedEdits={quitWhenIdle.unsyncedEdits}
          onQuitNow={quitWhenIdle.quitNow}
          onQuitWhenIdle={quitWhenIdle.quitWhenIdle}
          onCancel={quitWhenIdle.dismiss}
        />
      )}
    </div>
  );
}
