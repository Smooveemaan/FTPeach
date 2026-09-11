import type { ConnectionForm, PaneId, PaneKind, TabState } from './paneModel.ts';
import { PANE_IDS, makePane, makeTab } from './paneModel.ts';

// How many closed tabs can be brought back, most recent first.
export const CLOSED_TAB_LIMIT = 25;

// What a pane needs to come back where it was. The listing and selection are
// left behind: the reopened tab lists every folder afresh.
interface ClosedPane {
  kind: PaneKind;
  path: string;
  history: string[];
  future: string[];
  form: ConnectionForm;
  siteId: string | null;
  siteLabel: string;
  // Only a pane that was connected (or on its way) when its tab closed
  // reconnects; one left idle or on an error stays that way.
  reconnect: boolean;
}

export interface ClosedTab {
  index: number;
  name: string;
  syncBrowsing: boolean;
  panes: Record<PaneId, ClosedPane>;
}

export function snapshotClosedTab(tab: TabState, index: number): ClosedTab {
  const snapshotPane = (id: PaneId): ClosedPane => {
    const pane = tab.panes[id];
    return {
      kind: pane.kind,
      path: pane.path,
      history: pane.history,
      future: pane.future,
      form: pane.form,
      siteId: pane.siteId,
      siteLabel: pane.siteLabel,
      reconnect:
        pane.kind === 'remote' && (pane.status === 'connected' || pane.status === 'connecting'),
    };
  };
  return {
    index,
    name: tab.name,
    syncBrowsing: tab.syncBrowsing,
    panes: { a: snapshotPane('a'), b: snapshotPane('b') },
  };
}

export function pushClosedTab(
  stack: readonly ClosedTab[],
  closed: ClosedTab,
  limit = CLOSED_TAB_LIMIT,
): ClosedTab[] {
  return [...stack, closed].slice(-limit);
}

export function restoreClosedTab(closed: ClosedTab, id: string): TabState {
  const tab = makeTab(id);
  tab.name = closed.name;
  tab.syncBrowsing = closed.syncBrowsing;
  PANE_IDS.forEach((paneId) => {
    const { kind, path, history, future, form, siteId, siteLabel } = closed.panes[paneId];
    tab.panes[paneId] = {
      ...makePane(paneId, kind),
      path,
      history,
      future,
      form,
      siteId,
      siteLabel,
    };
  });
  return tab;
}

// Puts the tab back at its old position, or at the end when fewer tabs are
// open now than when it was closed.
export function insertTab(tabs: readonly TabState[], tab: TabState, index: number): TabState[] {
  const next = [...tabs];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, tab);
  return next;
}
