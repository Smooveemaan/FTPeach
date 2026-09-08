import { PANE_IDS } from './paneModel.ts';
import type { PaneId, PaneState, PaneStatus, TabState } from './paneModel.ts';

type PaneOrientation = 'horizontal' | 'vertical';
interface Translate {
  (key: string): string;
  (key: string, values: Record<string, string | number>): string;
}

interface PaneConnectionModelOptions {
  tabs: TabState[];
  panes: Record<PaneId, PaneState>;
  paneOrientation: PaneOrientation;
  translate: Translate;
}

export interface PaneConnectionModel {
  aggregateStatus: PaneStatus;
  connectedRemotePanes: PaneState[];
  soleConnectedRemotePane: PaneState | null;
  freeConnectTargetPaneId: PaneId | null;
  openConnectionIds: Set<string>;
  connectionLabels: Map<string, string>;
}

const isPaneBusy = (pane: PaneState) => pane.status === 'connected' || pane.status === 'connecting';

const baseConnectionLabel = (pane: PaneState) =>
  pane.siteLabel || (pane.form.protocol === 'webdav' ? pane.form.webdavUrl : pane.form.host) || '?';

export function buildPaneConnectionModel({
  tabs,
  panes,
  paneOrientation,
  translate,
}: PaneConnectionModelOptions): PaneConnectionModel {
  const remotePanes = PANE_IDS.map((id) => panes[id]).filter((pane) => pane.kind === 'remote');
  const aggregateStatus: PaneStatus = remotePanes.some((pane) => pane.status === 'connecting')
    ? 'connecting'
    : remotePanes.some((pane) => pane.status === 'connected')
      ? 'connected'
      : remotePanes.some((pane) => pane.status === 'error')
        ? 'error'
        : 'idle';

  const connectedRemotePanes = remotePanes.filter((pane) => pane.status === 'connected');
  const soleConnectedRemotePane =
    connectedRemotePanes.length > 1 ? null : (connectedRemotePanes[0] ?? null);
  const freeConnectTargetPaneId: PaneId | null = !isPaneBusy(panes.b)
    ? 'b'
    : !isPaneBusy(panes.a)
      ? 'a'
      : null;

  const openPaneEntries = tabs.flatMap((tab, tabIndex) =>
    PANE_IDS.flatMap((id) => {
      const pane = tab.panes[id];
      return pane.kind === 'remote' && isPaneBusy(pane) && pane.connectionId
        ? [{ tabIndex, id, pane, connectionId: pane.connectionId }]
        : [];
    }),
  );
  const openConnectionIds = new Set(openPaneEntries.map(({ connectionId }) => connectionId));
  const baseLabelCounts = new Map<string, number>();
  for (const { pane } of openPaneEntries) {
    const base = baseConnectionLabel(pane);
    baseLabelCounts.set(base, (baseLabelCounts.get(base) || 0) + 1);
  }
  const sideWord = (id: PaneId) =>
    paneOrientation === 'vertical'
      ? id === 'a'
        ? translate('paneSide.top')
        : translate('paneSide.bottom')
      : id === 'a'
        ? translate('paneSide.left')
        : translate('paneSide.right');
  const connectionLabels = new Map(
    openPaneEntries.map(({ tabIndex, id, pane, connectionId }) => {
      const base = baseConnectionLabel(pane);
      const label =
        (baseLabelCounts.get(base) ?? 0) > 1
          ? tabs.length > 1
            ? translate('paneSide.labelWithTab', {
                base,
                tabNumber: tabIndex + 1,
                side: sideWord(id),
              })
            : translate('paneSide.labelWithSide', { base, side: sideWord(id) })
          : base;
      return [connectionId, label] as const;
    }),
  );

  return {
    aggregateStatus,
    connectedRemotePanes,
    soleConnectedRemotePane,
    freeConnectTargetPaneId,
    openConnectionIds,
    connectionLabels,
  };
}
