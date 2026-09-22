import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { registerShutdownWriter } from '../../../platform/shutdownPersistence.ts';
import { api } from '../../../platform/api/index.ts';
import type { PersistedTabsState } from '../../../platform/api/tabs.ts';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import { reportAsyncFailure, reportRejection } from '../../../shared/asyncFailure.ts';
import { commandResultError } from '../../../shared/errorMessages.ts';
import type { ConnectionForm, PaneId, PaneState, TabState } from './paneModel.ts';
import { PANE_IDS } from './paneModel.ts';
import { restorePaneTabs, serializePaneTabs } from './panePersistenceModel.ts';

type RefreshPane = (
  id: PaneId,
  targetPath?: string,
  paneOverride?: PaneState,
  tabId?: string,
) => Promise<CommandResult | void>;

type ConnectPane = (
  id: PaneId,
  overrideForm?: ConnectionForm,
  paneOverride?: PaneState,
  tabId?: string,
  startPath?: string,
) => () => Promise<void>;

/** Tells one failed write from a different one, so a repeat can stay quiet. */
function failureSignature(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].map((part) => (typeof part === 'string' ? part : '')).join(':');
  }
  return typeof error === 'string' ? error : '';
}

interface UsePaneSessionPersistenceOptions {
  tabs: TabState[];
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<TabState[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  panes: Record<PaneId, PaneState>;
  saveSessionOnExit: boolean;
  refreshPane: RefreshPane;
  connectPane: ConnectPane;
}

export function usePaneSessionPersistence({
  tabs,
  activeTabId,
  setTabs,
  setActiveTabId,
  panes,
  saveSessionOnExit,
  refreshPane,
  connectPane,
}: UsePaneSessionPersistenceOptions): void {
  const [hydrated, setHydrated] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistenceEnabledRef = useRef(true);
  const hydrationRef = useRef({ panes, setTabs, setActiveTabId, refreshPane, connectPane });

  // The session is one document: `tabs_set` replaces all of it, so an older
  // snapshot answering after a newer one would put back tabs the user has
  // already left. Writes therefore run one at a time, in the order their
  // snapshots were taken, and a snapshot that a newer one replaced before its
  // turn came is dropped rather than written first.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(0);
  const savedSnapshotRef = useRef<string | null>(null);
  const reportedFailureRef = useRef<string | null>(null);
  const writeFailedRef = useRef(false);

  // A disk that refuses one write refuses the next one too, and the user
  // changes tabs while it does. The first refusal is the news; repeating it
  // every 400 ms would bury whatever else the app has to say.
  const reportWriteFailure = useCallback((error: unknown) => {
    const signature = failureSignature(error);
    if (reportedFailureRef.current === signature) return;
    reportedFailureRef.current = signature;
    reportAsyncFailure(error);
  }, []);

  const writeSession = useCallback(
    (state: PersistedTabsState | null) => {
      const snapshot = state === null ? null : JSON.stringify(state);
      // Nothing changed since the last write that actually landed. A write that
      // failed leaves the stored snapshot behind, so its retry still goes out.
      const revision = ++revisionRef.current;
      writeChainRef.current = writeChainRef.current.then(async () => {
        if (revisionRef.current !== revision) return;
        if (snapshot !== null && snapshot === savedSnapshotRef.current) return;
        try {
          const result = state === null ? await api.tabs.clear() : await api.tabs.set(state);
          if (!result.ok) {
            writeFailedRef.current = true;
            reportWriteFailure(commandResultError(result));
            return;
          }
          savedSnapshotRef.current = snapshot;
          writeFailedRef.current = false;
          reportedFailureRef.current = null;
        } catch (error) {
          writeFailedRef.current = true;
          reportWriteFailure(error);
        }
      });
      return writeChainRef.current;
    },
    [reportWriteFailure],
  );

  useLayoutEffect(
    () =>
      registerShutdownWriter('tabs', async () => {
        if (!hydrated) return;
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
        await writeSession(saveSessionOnExit ? serializePaneTabs(tabs, activeTabId) : null);
        if (writeFailedRef.current) throw new Error('Tabs could not be saved before exit');
      }),
    [hydrated, tabs, activeTabId, saveSessionOnExit, writeSession],
  );

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const [persisted, siteList, storedSettings] = await Promise.all([
        api.tabs.get(),
        api.sites.list(),
        api.settings.get(),
      ]);
      if (cancelled) return;

      const shouldPersistSession = storedSettings.saveSessionOnExit !== false;
      persistenceEnabledRef.current = shouldPersistSession;
      if (!shouldPersistSession) await writeSession(null);

      const initial = hydrationRef.current;
      const restored =
        shouldPersistSession && Array.isArray(siteList)
          ? restorePaneTabs(persisted, siteList)
          : null;
      if (!restored) {
        PANE_IDS.forEach((id) => {
          if (initial.panes[id].kind === 'local') reportRejection(initial.refreshPane(id));
        });
        setHydrated(true);
        return;
      }

      initial.setTabs(restored.tabs);
      initial.setActiveTabId(restored.activeTabId);
      restored.tabs.forEach((tab) => {
        PANE_IDS.forEach((id) => {
          const pane = tab.panes[id];
          if (pane.kind === 'local') {
            reportRejection(initial.refreshPane(id, pane.path || undefined, pane, tab.id));
          } else if (pane.siteId && storedSettings.autoReconnectTabs) {
            reportRejection(initial.connectPane(id, pane.form, pane, tab.id, pane.path || '/')());
          }
        });
      });
      setHydrated(true);
    };

    reportRejection(hydrate());
    return () => {
      cancelled = true;
    };
    // `writeSession` is stable, so this still runs once, on mount.
  }, [writeSession]);

  useEffect(() => {
    if (!hydrated) return;
    persistenceEnabledRef.current = saveSessionOnExit;
    if (!saveSessionOnExit) {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      void writeSession(null);
    }
  }, [hydrated, saveSessionOnExit, writeSession]);

  useEffect(() => {
    if (!hydrated || !persistenceEnabledRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      // A failed write here is invisible until the next launch, when the
      // user's tabs come back wrong or not at all. Say so while they can act.
      void writeSession(serializePaneTabs(tabs, activeTabId));
    }, 400);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [tabs, activeTabId, hydrated, saveSessionOnExit, writeSession]);
}
