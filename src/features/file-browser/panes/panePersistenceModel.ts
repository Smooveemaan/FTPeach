import type { PersistedPane, PersistedTabsState } from '../../../platform/api/tabs.ts';
import type { ManagedSite } from '../../../shared/types.ts';
import { PANE_IDS, buildFormFromSite, makePane, makeTab } from './paneModel.ts';
import type { PaneState, TabState } from './paneModel.ts';

export interface RestoredPaneTabs {
  tabs: TabState[];
  activeTabId: string;
}

export function restorePaneTabs(
  persisted: PersistedTabsState,
  sites: ManagedSite[],
  createId: () => string = () => crypto.randomUUID(),
): RestoredPaneTabs | null {
  if (!Array.isArray(persisted.tabs) || persisted.tabs.length === 0) return null;

  const sitesById = new Map(
    sites.filter((site) => site.kind !== 'folder').map((site) => [site.id, site]),
  );
  const tabs = persisted.tabs.map((record) => {
    const tab = makeTab(typeof record.id === 'string' && record.id ? record.id : createId());
    tab.name = typeof record.name === 'string' ? record.name : '';
    tab.syncBrowsing = !!record.syncBrowsing;
    PANE_IDS.forEach((id) => {
      const persistedPane = record.panes?.[id];
      if (
        persistedPane?.kind === 'remote' &&
        typeof persistedPane.siteId === 'string' &&
        sitesById.has(persistedPane.siteId)
      ) {
        const site = sitesById.get(persistedPane.siteId)!;
        tab.panes[id] = {
          ...makePane(id, 'remote'),
          form: buildFormFromSite(site),
          siteLabel: site.name,
          siteId: site.id,
          path:
            typeof persistedPane.path === 'string' && persistedPane.path
              ? persistedPane.path
              : site.remotePath || '/',
        };
      } else if (persistedPane?.kind === 'local') {
        tab.panes[id] = { ...makePane(id, 'local'), path: persistedPane.path || '' };
      } else {
        const fallbackKind =
          persistedPane?.kind === 'remote' ? 'remote' : id === 'a' ? 'local' : 'remote';
        tab.panes[id] = makePane(id, fallbackKind);
      }
    });
    return tab;
  });
  // `persisted.tabs` was non-empty, so `tabs` is too — but nothing downstream
  // can work without a first tab, so say so here rather than index blindly.
  const [firstTab] = tabs;
  if (!firstTab) return null;
  const activeTabId = tabs.some((tab) => tab.id === persisted.activeTabId)
    ? (persisted.activeTabId ?? firstTab.id)
    : firstTab.id;

  return { tabs, activeTabId };
}

function serializePane(pane: PaneState): PersistedPane {
  if (pane.kind === 'local') return { kind: 'local', path: pane.path };
  if (pane.siteId) return { kind: 'remote', siteId: pane.siteId, path: pane.path };
  return { kind: 'remote' };
}

export function serializePaneTabs(tabs: TabState[], activeTabId: string): PersistedTabsState {
  return {
    activeTabId,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      name: tab.name || '',
      syncBrowsing: !!tab.syncBrowsing,
      panes: {
        a: serializePane(tab.panes.a),
        b: serializePane(tab.panes.b),
      },
    })),
  };
}
