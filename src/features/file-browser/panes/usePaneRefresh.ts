import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import type { FriendlyErrorInput } from '../../../shared/errorMessages.ts';
import { commandResultError } from '../../../shared/errorMessages.ts';
import { isConnectionDead, retainConnectionRequest } from '../../transfers/index.ts';
import { backendFor } from './paneBackend.ts';
import type { PaneId, PaneState } from './paneModel.ts';

type UpdatePane = (
  id: PaneId,
  patch: Partial<PaneState> | ((pane: PaneState) => Partial<PaneState>),
  tabId?: string,
) => void;

interface UsePaneRefreshOptions {
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  updatePane: UpdatePane;
  reportError: (error: FriendlyErrorInput) => unknown;
  setErrorMessage: (message: string) => unknown;
  defaultLocalPath: string;
}

export type PaneRequestIds = Record<string, Record<PaneId, number>>;
export type PaneRefreshes = Record<string, { key: string; promise: Promise<CommandResult | void> }>;

export interface PaneRefreshModel {
  refreshPane: (
    id: PaneId,
    targetPath?: string,
    paneOverride?: PaneState,
    tabId?: string,
  ) => Promise<CommandResult | void>;
  ensureRequestIds: (tabId: string) => Record<PaneId, number>;
  requestIdsRef: MutableRefObject<PaneRequestIds>;
  inFlightRefreshesRef: MutableRefObject<PaneRefreshes>;
}

export function usePaneRefresh({
  panes,
  activeTabId,
  updatePane,
  reportError,
  setErrorMessage,
  defaultLocalPath,
}: UsePaneRefreshOptions): PaneRefreshModel {
  const requestIdsRef = useRef<PaneRequestIds>({});
  const inFlightRefreshesRef = useRef<PaneRefreshes>({});
  const localRequests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const requests = localRequests.current;
    return () => {
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, [activeTabId, panes.a.kind, panes.b.kind]);
  const connectionA = panes.a.kind === 'remote' ? panes.a.connectionId : null;
  const connectionB = panes.b.kind === 'remote' ? panes.b.connectionId : null;
  useEffect(() => {
    const releases = [connectionA, connectionB]
      .filter((id): id is string => !!id)
      .map(retainConnectionRequest);
    return () => releases.forEach((release) => release());
  }, [connectionA, connectionB]);

  const ensureRequestIds = useCallback((tabId: string) => {
    if (!requestIdsRef.current[tabId]) requestIdsRef.current[tabId] = { a: 0, b: 0 };
    return requestIdsRef.current[tabId];
  }, []);

  const refreshPane = useCallback(
    async (
      id: PaneId,
      targetPath = '',
      paneOverride?: PaneState,
      tabId = activeTabId,
    ): Promise<CommandResult | void> => {
      const pane = paneOverride || panes[id];
      const localTargetPath = targetPath || defaultLocalPath || '';
      const resolvedPath = pane.kind === 'local' ? localTargetPath : targetPath || '/';
      const refreshKey = `${pane.kind}:${pane.connectionId || ''}:${resolvedPath}`;
      const slotKey = `${tabId}:${id}`;
      const existing = inFlightRefreshesRef.current[slotKey];
      if (existing?.key === refreshKey) return existing.promise;
      localRequests.current.get(slotKey)?.abort();
      const controller = new AbortController();
      localRequests.current.set(slotKey, controller);

      const releaseConnection =
        pane.kind === 'remote' && pane.connectionId
          ? retainConnectionRequest(pane.connectionId)
          : () => {};
      const promise = (async () => {
        const requestIds = ensureRequestIds(tabId);
        const requestId = (requestIds[id] += 1);
        updatePane(id, { loading: true }, tabId);
        const result = await backendFor(pane).list(
          pane.kind === 'local' ? localTargetPath || undefined : targetPath,
          `${slotKey}:${crypto.randomUUID()}`,
          controller.signal,
        );
        if (requestId !== requestIds[id] || controller.signal.aborted) return;
        if (pane.kind === 'remote' && pane.connectionId && isConnectionDead(pane.connectionId)) {
          updatePane(id, { loading: false }, tabId);
          return;
        }
        if (result.ok) {
          // A local listing that came back without a path leaves the pane's
          // current path alone instead of blanking it.
          const nextPath = pane.kind === 'local' ? result.path : targetPath;
          updatePane(
            id,
            {
              loading: false,
              ...(nextPath === undefined ? {} : { path: nextPath }),
              entries: result.entries,
              selected: new Set(),
              refreshedAt: Date.now(),
            },
            tabId,
          );
          setErrorMessage('');
        } else {
          updatePane(id, { loading: false }, tabId);
          // A listing that lands after the user closed this session failed for
          // exactly the reason they asked for. Reporting it would blame the
          // server for a disconnect the user performed themselves.
          const closedOnPurpose =
            pane.kind === 'remote' && !!pane.connectionId && isConnectionDead(pane.connectionId);
          // Initial listing failures are shown by connectPane in the remote pane.
          if (!closedOnPurpose && (pane.kind !== 'remote' || pane.status !== 'connecting')) {
            reportError(commandResultError(result));
          }
        }
        return result;
      })();

      inFlightRefreshesRef.current[slotKey] = { key: refreshKey, promise };
      try {
        return await promise;
      } finally {
        releaseConnection();
        if (localRequests.current.get(slotKey) === controller)
          localRequests.current.delete(slotKey);
        // A later refresh of the same slot can have replaced or deleted this
        // entry while the promise above was in flight; the compiler still sees
        // the assignment a few lines up.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (inFlightRefreshesRef.current[slotKey]?.promise === promise) {
          delete inFlightRefreshesRef.current[slotKey];
        }
      }
    },
    [
      activeTabId,
      defaultLocalPath,
      ensureRequestIds,
      panes,
      reportError,
      setErrorMessage,
      updatePane,
    ],
  );

  return { refreshPane, ensureRequestIds, requestIdsRef, inFlightRefreshesRef };
}
