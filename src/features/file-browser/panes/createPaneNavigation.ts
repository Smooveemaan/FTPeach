import { joinLocalPath, joinRemotePath } from '../../../shared/paths.ts';
import { parentRemotePath, remoteCrumbs } from '../remotePath.ts';
import { paneJoin } from './paneBackend.ts';
import { reportRejection } from '../../../shared/asyncFailure.ts';
import { PANE_IDS, otherPaneId } from './paneModel.ts';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PathCrumb } from '../components/PathBar.tsx';
import type { PaneId, PaneState, TabState } from './paneModel.ts';
import type { PaneRefreshes } from './usePaneRefresh.ts';

type SyncAnchors = Record<string, Record<PaneId, string>>;
type PanePatch = Partial<PaneState> | ((pane: PaneState) => Partial<PaneState>);

interface RefreshResult {
  ok?: boolean;
  path?: string;
}

interface PaneNavigationOptions {
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  syncBrowsing: boolean;
  setTabs: Dispatch<SetStateAction<TabState[]>>;
  syncAnchorsRef: MutableRefObject<SyncAnchors>;
  inFlightRefreshesRef: MutableRefObject<PaneRefreshes>;
  pendingDescendRef: MutableRefObject<Record<string, string[]>>;
  refreshPane: (
    id: PaneId,
    path: string,
    paneOverride?: PaneState,
    tabId?: string,
  ) => Promise<RefreshResult | void>;
  updatePane: (id: PaneId, patch: PanePatch, tabId?: string) => void;
}

export interface NavigateOptions {
  isHistoryNav?: boolean;
  historyDirection?: 'back' | 'forward';
}

export function createPaneNavigation({
  panes,
  activeTabId,
  syncBrowsing,
  setTabs,
  syncAnchorsRef,
  inFlightRefreshesRef,
  pendingDescendRef,
  refreshPane,
  updatePane,
}: PaneNavigationOptions) {
  const localCrumbsFor = (path: string): PathCrumb[] => {
    if (!path) return [{ label: '…', path }];
    const isUnc = path.startsWith('\\\\');
    const parts = path.split('\\').filter(Boolean);
    const crumbs: PathCrumb[] = [];
    if (isUnc) {
      if (parts.length === 0) return [{ label: '…', path }];
      const shareParts = parts.slice(0, 2);
      let acc = `\\\\${shareParts.join('\\')}`;
      crumbs.push({ label: shareParts.join('\\'), path: acc });
      for (const part of parts.slice(2)) {
        acc = `${acc}\\${part}`;
        crumbs.push({ label: part, path: acc });
      }
      return crumbs;
    }
    let acc = '';
    for (const part of parts) {
      acc = acc === '' ? `${part}\\` : acc.endsWith('\\') ? acc + part : `${acc}\\${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  };

  const crumbsFor = (pane: PaneState): PathCrumb[] =>
    pane.kind === 'local' ? localCrumbsFor(pane.path) : remoteCrumbs(pane.path);

  // The single "Up" implementation for both pane kinds: Windows path math
  // for local panes, parentRemotePath for remote ones.
  const paneParent = (id: PaneId) => {
    const pane = panes[id];
    if (pane.kind === 'remote') {
      reportRejection(navigatePane(id, parentRemotePath(pane.path)));
      return;
    }
    if (!pane.path) return;
    const isUnc = pane.path.startsWith('\\\\');
    const parts = pane.path.split('\\').filter(Boolean);
    if (parts.length <= (isUnc ? 2 : 1)) return; // already at a drive root / UNC share root
    parts.pop();
    const next = isUnc
      ? `\\\\${parts.join('\\')}`
      : parts.length === 1
        ? `${parts[0]}\\`
        : parts.join('\\');
    reportRejection(navigatePane(id, next));
  };

  const toggleSync = (tabId = activeTabId) =>
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        if (!t.syncBrowsing)
          syncAnchorsRef.current[tabId] = { a: t.panes.a.path, b: t.panes.b.path };
        return { ...t, syncBrowsing: !t.syncBrowsing };
      }),
    );

  const syncEligible = !(panes.a.kind === 'local' && panes.b.kind === 'local');

  const mirrorNavigation = (sourceId: PaneId, newPath: string, tabId = activeTabId) => {
    if (!syncBrowsing || !syncEligible) return;
    const targetId = otherPaneId(sourceId);
    const sourcePane = panes[sourceId];
    const targetPane = panes[targetId];
    const sourceSep = sourcePane.kind === 'local' ? '\\' : '/';
    const anchors = syncAnchorsRef.current[tabId] || { a: '', b: '' };
    const anchorSource = anchors[sourceId];
    const anchorTarget = anchors[targetId];
    const normalizedAnchor = anchorSource.endsWith(sourceSep)
      ? anchorSource
      : anchorSource + sourceSep;
    if (newPath !== anchorSource && !newPath.startsWith(normalizedAnchor)) return;
    const suffix =
      newPath === anchorSource
        ? []
        : newPath.slice(normalizedAnchor.length).split(sourceSep).filter(Boolean);
    const target =
      targetPane.kind === 'local'
        ? suffix.length
          ? `${anchorTarget}${anchorTarget.endsWith('\\') ? '' : '\\'}${suffix.join('\\')}`
          : anchorTarget
        : suffix.reduce((acc, seg) => joinRemotePath(acc, seg), anchorTarget);
    reportRejection(refreshPane(targetId, target, undefined, tabId));
  };

  const navigatePane = async (
    id: PaneId,
    path: string,
    { isHistoryNav = false, historyDirection }: NavigateOptions = {},
    tabId = activeTabId,
  ) => {
    const pane = panes[id];
    const previousPath = pane.path;
    const shouldPushHistory = !isHistoryNav && previousPath && path !== previousPath;
    const resPromise = refreshPane(id, path, undefined, tabId);
    const res = await resPromise;
    if (res?.ok && historyDirection) {
      updatePane(
        id,
        (p) => {
          // A deduplicated refresh may have several callers; only consume the
          // history entry once, after the winning listing has committed.
          if (historyDirection === 'back' && p.history.at(-1) === path) {
            return { history: p.history.slice(0, -1), future: [previousPath, ...p.future] };
          }
          if (historyDirection === 'forward' && p.future[0] === path) {
            return { future: p.future.slice(1), history: [...p.history, previousPath] };
          }
          return {};
        },
        tabId,
      );
    }
    if (shouldPushHistory && res && res.ok) {
      updatePane(
        id,
        (p) =>
          p.history.at(-1) === previousPath
            ? {}
            : { history: [...p.history, previousPath], future: [] },
        tabId,
      );
    }
    if (res && res.ok) {
      mirrorNavigation(id, res.path || path, tabId);
      // Continue any hop openDirectory() queued for this slot while this
      // navigation was in flight (see its comment below), one at a time.
      const slotKey = `${tabId}:${id}`;
      const nextName = pendingDescendRef.current[slotKey]?.shift();
      if (nextName) {
        const resolvedPath = pane.kind === 'local' ? res.path || path : path;
        const nextPath =
          pane.kind === 'local'
            ? joinLocalPath(resolvedPath, nextName)
            : joinRemotePath(resolvedPath, nextName);
        reportRejection(navigatePane(id, nextPath, {}, tabId));
      }
    } else if (res?.ok === false) {
      delete pendingDescendRef.current[`${tabId}:${id}`];
    }
  };

  // Entry point for opening a directory by name (double-click / Enter).
  // Resolving the target path needs the pane's *current* path — but while a
  // navigation for this pane is still in flight, `panes[id].path` is
  // guaranteed to still be the pre-navigation value (it only updates once
  // the listing actually lands), so joining against it now would just
  // re-target the request already in flight and silently go nowhere. Queue
  // the name instead; navigatePane() continues the chain once that request
  // resolves, using the path it actually landed on.
  const openDirectory = (id: PaneId, name: string, tabId = activeTabId) => {
    const slotKey = `${tabId}:${id}`;
    if (inFlightRefreshesRef.current[slotKey]) {
      const queue = pendingDescendRef.current[slotKey] || (pendingDescendRef.current[slotKey] = []);
      queue.push(name);
      return;
    }
    reportRejection(navigatePane(id, paneJoin(panes[id], name)));
  };

  const goPaneBack = (id: PaneId, tabId = activeTabId) => {
    const pane = panes[id];
    if (pane.history.length === 0) return;
    const prev = pane.history[pane.history.length - 1];
    if (prev === undefined) return;
    reportRejection(
      navigatePane(id, prev, { isHistoryNav: true, historyDirection: 'back' }, tabId),
    );
  };

  const goPaneForward = (id: PaneId, tabId = activeTabId) => {
    const pane = panes[id];
    if (pane.future.length === 0) return;
    const next = pane.future[0];
    if (next === undefined) return;
    reportRejection(
      navigatePane(id, next, { isHistoryNav: true, historyDirection: 'forward' }, tabId),
    );
  };

  const refreshBothPanes = (tabId = activeTabId) => {
    PANE_IDS.forEach((id) => {
      const pane = panes[id];
      if (pane.kind === 'local' || pane.status === 'connected')
        reportRejection(refreshPane(id, pane.path, undefined, tabId));
    });
  };

  return {
    crumbsFor,
    paneParent,
    toggleSync,
    syncEligible,
    navigatePane,
    openDirectory,
    goPaneBack,
    goPaneForward,
    refreshBothPanes,
  };
}
