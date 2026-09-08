import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../platform/api/index.ts';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import { reportAsyncFailure, reportRejection } from '../../../shared/asyncFailure.ts';
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
      if (!shouldPersistSession) api.tabs.clear().catch(reportAsyncFailure);

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
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    persistenceEnabledRef.current = saveSessionOnExit;
    if (!saveSessionOnExit) {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      api.tabs.clear().catch(reportAsyncFailure);
    }
  }, [hydrated, saveSessionOnExit]);

  useEffect(() => {
    if (!hydrated || !persistenceEnabledRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      // A failed write here is invisible until the next launch, when the
      // user's tabs come back wrong or not at all. Say so while they can act.
      reportRejection(api.tabs.set(serializePaneTabs(tabs, activeTabId)));
    }, 400);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [tabs, activeTabId, hydrated, saveSessionOnExit]);
}
