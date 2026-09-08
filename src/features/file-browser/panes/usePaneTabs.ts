import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import type { PaneId, PaneState, TabState } from './paneModel.ts';
import { makeTab } from './paneModel.ts';

type PanePatch = Partial<PaneState> | ((pane: PaneState) => Partial<PaneState>);
type TabPatch = Partial<TabState> | ((tab: TabState) => Partial<TabState>);

export function reorderTabs(tabs: TabState[], sourceId: string, targetId: string): TabState[] {
  if (sourceId === targetId) return tabs;
  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return tabs;
  const next = [...tabs];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return tabs;
  next.splice(targetIndex, 0, source);
  return next.every((tab, index) => tab === tabs[index]) ? tabs : next;
}

export interface PaneTabsModel {
  tabs: TabState[];
  setTabs: Dispatch<SetStateAction<TabState[]>>;
  activeTab: TabState;
  activeTabId: string;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  panes: Record<PaneId, PaneState>;
  syncBrowsing: boolean;
  updatePane: (id: PaneId, patch: PanePatch, tabId?: string) => void;
  updateTab: (tabId: string, patch: TabPatch) => void;
  reorderTab: (sourceId: string, targetId: string) => void;
  lastActivePaneId: PaneId | null;
  activatePane: Dispatch<SetStateAction<PaneId | null>>;
}

export function usePaneTabs(): PaneTabsModel {
  // The strip is never empty in practice (closing the last tab is blocked), but
  // the first tab of the session is kept as the fallback so that invariant is
  // expressed rather than assumed at every index.
  const [initialTab] = useState(() => makeTab(crypto.randomUUID()));
  const [tabs, setTabs] = useState<TabState[]>(() => [initialTab]);
  const [activeTabId, setActiveTabId] = useState(() => initialTab.id);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? initialTab;
  // Pane the user last clicked into — target for menu-driven bookmark/local-path connect
  // actions; null until first click, so nothing is implicitly "active" at launch.
  const [lastActivePaneId, setLastActivePaneId] = useState<PaneId | null>(null);

  const updatePane = (id: PaneId, patch: PanePatch, tabId = activeTabId) => {
    setTabs((previous) =>
      previous.map((tab) =>
        tab.id !== tabId
          ? tab
          : {
              ...tab,
              panes: {
                ...tab.panes,
                [id]: {
                  ...tab.panes[id],
                  ...(typeof patch === 'function' ? patch(tab.panes[id]) : patch),
                },
              },
            },
      ),
    );
  };

  const updateTab = (tabId: string, patch: TabPatch) => {
    setTabs((previous) =>
      previous.map((tab) =>
        tab.id === tabId ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab,
      ),
    );
  };

  const reorderTab = (sourceId: string, targetId: string) =>
    setTabs((previous) => reorderTabs(previous, sourceId, targetId));

  return {
    tabs,
    setTabs,
    activeTab,
    activeTabId,
    setActiveTabId,
    panes: activeTab.panes,
    syncBrowsing: activeTab.syncBrowsing,
    updatePane,
    updateTab,
    reorderTab,
    lastActivePaneId,
    activatePane: setLastActivePaneId,
  };
}
