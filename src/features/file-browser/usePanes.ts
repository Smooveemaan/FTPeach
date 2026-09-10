import type { Dispatch, SetStateAction } from 'react';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../platform/api/index.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import { isolate } from '../../shared/bidi.ts';
import type { FriendlyErrorInput } from '../../shared/errorMessages.ts';
import type { FileEntry, ManagedSite } from '../../shared/types.ts';
import {
  getTransfersSnapshot,
  isTransferNameConflict,
  transferTouchesConnection,
} from '../transfers/index.ts';
import type { PathCrumb } from './components/PathBar.tsx';
import { createPaneFileOperations } from './panes/createPaneFileOperations.ts';
import type { NavigateOptions } from './panes/createPaneNavigation.ts';
import { createPaneNavigation } from './panes/createPaneNavigation.ts';
import { createPaneSessionLifecycle } from './panes/createPaneSessionLifecycle.ts';
import { backendFor, paneJoin } from './panes/paneBackend.ts';
import { buildPaneConnectionModel } from './panes/paneConnectionModel.ts';
import type { ConnectionForm, PaneId, PaneState, PaneStatus, TabState } from './panes/paneModel.ts';
import { PANE_IDS, makeTab } from './panes/paneModel.ts';
import { usePaneRefresh } from './panes/usePaneRefresh.ts';
import { useClearPaneSelection, useTransferConnectionLoss } from './panes/usePaneRuntimeEffects.ts';
import { usePaneSessionPersistence } from './panes/usePaneSessionPersistence.ts';
import { usePaneTabs } from './panes/usePaneTabs.ts';
import { useRecentSites } from './panes/useRecentSites.ts';
interface ConfirmOptions {
  confirmLabel?: string;
  danger?: boolean;
}
interface UsePanesOptions {
  reportError: (error: FriendlyErrorInput) => unknown;
  setErrorMessage: (message: string) => unknown;
  requestConfirm: (message: string, onConfirm: () => unknown, options?: ConfirmOptions) => unknown;
  concurrency: number;
  connectTimeout: number;
  paneOrientation: 'horizontal' | 'vertical';
  overwriteAction: 'ask' | 'skip' | 'overwrite';
  ftpActiveMode: boolean;
  saveSessionOnExit: boolean;
  defaultLocalPath: string;
  onVaultUnlockRequired: (retry: () => unknown) => void;
  stopTransfersForConnection: (connectionId: string) => Promise<unknown>;
}

export { PANE_IDS, otherPaneId } from './panes/paneModel.ts';

export interface PanesModel {
  tabs: TabState[];
  activeTabId: string;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  panes: Record<PaneId, PaneState>;
  syncBrowsing: boolean;
  syncEligible: boolean;
  updatePane: (
    id: PaneId,
    patch: Partial<PaneState> | ((pane: PaneState) => Partial<PaneState>),
    tabId?: string,
  ) => void;
  updateTab: (
    tabId: string,
    patch: Partial<TabState> | ((tab: TabState) => Partial<TabState>),
  ) => void;
  reorderTab: (sourceId: string, targetId: string) => void;
  setPaneForm: (id: PaneId, form: ConnectionForm) => void;
  paneJoin: (pane: PaneState, name: string) => string;
  crumbsFor: (pane: PaneState) => PathCrumb[];
  paneParent: (id: PaneId) => void;
  refreshPane: (
    id: PaneId,
    targetPath?: string,
    paneOverride?: PaneState,
    tabId?: string,
  ) => Promise<CommandResult | void>;
  navigatePane: (
    id: PaneId,
    path: string,
    { isHistoryNav, historyDirection }?: NavigateOptions,
    tabId?: string,
  ) => Promise<void>;
  openDirectory: (id: PaneId, name: string, tabId?: string) => void;
  goPaneBack: (id: PaneId, tabId?: string) => void;
  goPaneForward: (id: PaneId, tabId?: string) => void;
  refreshBothPanes: (tabId?: string) => void;
  toggleSync: (tabId?: string) => void;
  startPaneConnect: (id: PaneId, tabId?: string) => void;
  switchPaneToLocal: (id: PaneId, tabId?: string, targetPath?: string) => void;
  connectPane: (
    id: PaneId,
    overrideForm?: ConnectionForm,
    paneOverride?: PaneState,
    tabId?: string,
    startPath?: string,
  ) => () => Promise<void>;
  disconnectPane: (id: PaneId, tabId?: string) => Promise<void>;
  cancelConnectPane: (id: PaneId, tabId?: string) => void;
  siteConnectPane: (id: PaneId, site: ManagedSite, tabId?: string) => void;
  connectSavedSite: (site: ManagedSite, paneId?: PaneId) => void;
  recentSiteIds: string[];
  openNewTab: () => void;
  closeTab: (tabId: string) => void;
  deletePaneSelected: (id: PaneId, tabId?: string, permanent?: boolean) => void;
  deletePaneEntry: (id: PaneId, entry: FileEntry, tabId?: string, permanent?: boolean) => void;
  submitNewFolder: (name: string, tabId: string, id: PaneId) => Promise<void>;
  submitNewFile: (name: string, tabId: string, id: PaneId) => Promise<void>;
  renamePaneEntry: (id: PaneId, entry: FileEntry, newName: string, tabId?: string) => Promise<void>;
  movePaneSamePane: (
    id: PaneId,
    names: readonly string[],
    targetFolder: string,
    tabId?: string,
  ) => Promise<void>;
  chooseLocalDir: (id: PaneId) => () => Promise<void>;
  goPaneHome: (id: PaneId) => () => Promise<void>;
  confirmOverwriteIfNeeded: (
    targetPane: PaneState,
    targetFolder: string | undefined,
    names: string[],
    proceed: (names: string[], overwriteApproved: boolean) => unknown,
    sourceEntries?: FileEntry[],
  ) => Promise<void>;
  canCopyBetween: (source: PaneState, target: PaneState) => boolean;
  aggregateStatus: PaneStatus;
  soleConnectedRemotePane: PaneState | null;
  connectedRemotePanes: PaneState[];
  freeConnectTargetPaneId: PaneId | null;
  openConnectionIds: Set<string>;
  connectionLabels: Map<string, string>;
  lastActivePaneId: PaneId | null;
  activatePane: Dispatch<SetStateAction<PaneId | null>>;
}

export function usePanes({
  reportError,
  setErrorMessage,
  requestConfirm,
  concurrency,
  connectTimeout,
  paneOrientation,
  overwriteAction,
  ftpActiveMode,
  saveSessionOnExit,
  defaultLocalPath,
  onVaultUnlockRequired,
  stopTransfersForConnection,
}: UsePanesOptions): PanesModel {
  const { t } = useTranslation();
  const {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    panes,
    syncBrowsing,
    updatePane,
    updateTab,
    reorderTab,
    lastActivePaneId,
    activatePane,
  } = usePaneTabs();
  useTransferConnectionLoss(setTabs, t('errors.connectionReset'));
  useClearPaneSelection(activeTabId, setTabs);
  const { recentSiteIds, pushRecentSite } = useRecentSites();

  const syncAnchorsRef = useRef<Record<string, Record<PaneId, string>>>({});
  const pendingDescendRef = useRef<Record<string, string[]>>({});

  const { refreshPane, ensureRequestIds, requestIdsRef, inFlightRefreshesRef } = usePaneRefresh({
    panes,
    activeTabId,
    updatePane,
    reportError,
    setErrorMessage,
    defaultLocalPath,
  });

  const {
    crumbsFor,
    paneParent,
    toggleSync,
    syncEligible,
    navigatePane,
    openDirectory,
    goPaneBack,
    goPaneForward,
    refreshBothPanes,
  } = createPaneNavigation({
    panes,
    activeTabId,
    syncBrowsing,
    setTabs,
    syncAnchorsRef,
    inFlightRefreshesRef,
    pendingDescendRef,
    refreshPane,
    updatePane,
  });

  // Connections

  const {
    startPaneConnect,
    switchPaneToLocal,
    setPaneForm,
    connectPane,
    disconnectPane,
    cancelConnectPane,
    siteConnectPane,
  } = createPaneSessionLifecycle({
    concurrency,
    connectTimeout,
    ftpActiveMode,
    panes,
    activeTabId,
    setTabs,
    updatePane,
    ensureRequestIds,
    refreshPane,
    pushRecentSite,
    onVaultUnlockRequired,
    requestConfirm,
    inFlightRefreshesRef,
    stopTransfersForConnection,
    t,
  });

  usePaneSessionPersistence({
    tabs,
    activeTabId,
    setTabs,
    setActiveTabId,
    panes,
    saveSessionOnExit,
    refreshPane,
    connectPane,
  });

  // Tabs
  // "Transfers"/"Log" intentionally shared across the entire application, not per-tab.

  const openNewTab = () => {
    const tab = makeTab(crypto.randomUUID());
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    PANE_IDS.forEach((id) => {
      if (tab.panes[id].kind === 'local')
        reportRejection(refreshPane(id, undefined, tab.panes[id], tab.id));
    });
  };

  const closeTab = (tabId: string) => {
    if (tabs.length === 1) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const connectionIds = PANE_IDS.map((id) => tab.panes[id].connectionId).filter(
      (id): id is string => Boolean(id),
    );
    const hasActive = Object.values(getTransfersSnapshot()).some(
      (t) =>
        connectionIds.some((cid) => transferTouchesConnection(t, cid)) &&
        (t.status === 'progress' || t.status === 'queued' || t.status === 'paused'),
    );
    const proceed = () => {
      const idx = tabs.findIndex((t) => t.id === tabId);
      const next = tabs.filter((t) => t.id !== tabId);
      setTabs(next);
      if (activeTabId === tabId) {
        const nextActive = next[idx - 1] ?? next[0];
        if (nextActive) setActiveTabId(nextActive.id);
      }
      delete requestIdsRef.current[tabId];
      delete syncAnchorsRef.current[tabId];
      // The queue outlives the tab, so settle its transfers the same way a pane
      // disconnect does before tearing the sessions down: cancelled on purpose
      // rather than racing the teardown into a spurious connection-lost error,
      // and with the connection marked gone so nothing offers a dead Retry.
      connectionIds.forEach((cid) =>
        reportRejection(stopTransfersForConnection(cid).then(() => api.session.disconnect(cid))),
      );
    };
    if (hasActive) {
      requestConfirm(t('confirm.closeTabWithActiveTransfers'), proceed, {
        confirmLabel: t('confirm.closeTabLabel'),
        danger: true,
      });
    } else {
      proceed();
    }
  };

  const confirmOverwriteIfNeeded = async (
    targetPane: PaneState,
    targetFolder: string | undefined,
    names: string[],
    proceed: (names: string[], overwriteApproved: boolean) => unknown,
    sourceEntries: FileEntry[] = [],
  ) => {
    let destEntries;
    if (!targetFolder) {
      destEntries = targetPane.entries;
    } else {
      const res = await backendFor(targetPane).list(paneJoin(targetPane, targetFolder));
      if (!res.ok) {
        reportError(res.error || 'Cannot list destination');
        return;
      }
      destEntries = res.entries;
    }
    const conflicts = names.filter((name) => {
      const source = sourceEntries.find((entry) => entry.name === name);
      const destination = destEntries.find((entry) =>
        targetPane.kind === 'local'
          ? entry.name.toLowerCase() === name.toLowerCase()
          : entry.name === name,
      );
      return isTransferNameConflict(source, destination);
    });
    // Whether the caller may treat the destination as approved: nothing to
    // overwrite, or the user has just said to overwrite it. The operation this
    // hands off to asks per destination path of its own accord, and without
    // this answer it would put a second dialog about the same file straight
    // after this one.
    if (conflicts.length === 0) {
      proceed(names, false);
      return;
    }
    if (overwriteAction === 'overwrite') {
      proceed(names, true);
      return;
    }
    if (overwriteAction === 'skip') {
      const remaining = names.filter((name) => !conflicts.includes(name));
      if (remaining.length > 0) proceed(remaining, false);
      return;
    }
    const message =
      conflicts.length === 1
        ? t('confirm.overwriteSingleExists', { name: isolate(conflicts[0]!) })
        : t('confirm.overwriteConflicts', { count: conflicts.length });
    requestConfirm(message, () => proceed(names, true), {
      confirmLabel: t('confirm.overwriteLabel'),
      danger: true,
    });
  };

  const canCopyBetween = (source: PaneState, target: PaneState) => {
    if (source.kind === 'remote' && source.status !== 'connected') return false;
    if (target.kind === 'remote' && target.status !== 'connected') return false;
    return true;
  };

  const {
    aggregateStatus,
    connectedRemotePanes,
    soleConnectedRemotePane,
    freeConnectTargetPaneId,
    openConnectionIds,
    connectionLabels,
  } = useMemo(
    () =>
      buildPaneConnectionModel({
        tabs,
        panes,
        paneOrientation,
        translate: t,
      }),
    [tabs, panes, paneOrientation, t],
  );

  const connectSavedSite = (site: ManagedSite, paneId?: PaneId) => {
    // No pane clicked yet this session: bookmarks default to the right pane,
    // local paths to the left — matching each manager's usual pane.
    const targetId = paneId || lastActivePaneId || (site.kind === 'local' ? 'a' : 'b');
    if (site.kind === 'local') {
      switchPaneToLocal(targetId, activeTabId, site.localPath);
      return;
    }
    const targetPane = panes[targetId];
    if (targetPane.status === 'connected') {
      requestConfirm(
        t('confirm.replaceConnection', {
          current: targetPane.siteLabel || targetPane.form.host,
          next: site.name,
        }),
        () => siteConnectPane(targetId, site),
        { confirmLabel: t('confirm.replaceConnectionLabel'), danger: true },
      );
      return;
    }
    siteConnectPane(targetId, site);
  };

  const {
    deletePaneSelected,
    deletePaneEntry,
    submitNewFolder,
    submitNewFile,
    renamePaneEntry,
    movePaneSamePane,
    chooseLocalDir,
    goPaneHome,
  } = createPaneFileOperations({
    panes,
    activeTabId,
    requestConfirm,
    reportError,
    refreshPane,
    navigatePane,
    t,
  });
  return {
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
  };
}
