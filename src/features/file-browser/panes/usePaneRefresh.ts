import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import type { FriendlyErrorInput } from '../../../shared/errorMessages.ts';
import { commandResultError, friendlyError } from '../../../shared/errorMessages.ts';
import { isConnectionDead, retainConnectionRequest } from '../../transfers/index.ts';
import { backendFor } from './paneBackend.ts';
import { isConnectionLoss } from './paneModel.ts';
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
  setErrorMessage: Dispatch<SetStateAction<string>>;
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
  /**
   * Lists a pane again if it still shows `path` on the tab that was active
   * when this was made. A transfer that reports or ends after the user browsed
   * elsewhere leaves the pane where it is.
   */
  refreshPaneIfAt: (id: PaneId, path: string) => Promise<CommandResult | void>;
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
  // The message a failed listing put up. A later listing that works takes back
  // only that one, never an error some other action just reported.
  const listingErrorRef = useRef('');
  const localRequests = useRef(
    new Map<string, { controller: AbortController; tabId: string; id: PaneId; kind: string }>(),
  );
  useEffect(() => {
    const requests = localRequests.current;
    return () => {
      for (const request of requests.values()) request.controller.abort();
      requests.clear();
    };
  }, []);
  // A pane that changed kind no longer wants the listing it started as the old
  // kind. Only those are aborted: switching Server -> Computer starts the new
  // local listing before this effect sees the new kind, and that one must live.
  const kindA = panes.a.kind;
  const kindB = panes.b.kind;
  useEffect(() => {
    const kinds: Record<PaneId, string> = { a: kindA, b: kindB };
    for (const request of localRequests.current.values()) {
      if (request.tabId === activeTabId && request.kind !== kinds[request.id]) {
        request.controller.abort();
      }
    }
  }, [activeTabId, kindA, kindB]);
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
      localRequests.current.get(slotKey)?.controller.abort();
      const controller = new AbortController();
      localRequests.current.set(slotKey, { controller, tabId, id, kind: pane.kind });

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
        if (requestId !== requestIds[id]) return;
        if (controller.signal.aborted) {
          // Nothing newer took over this slot, so nobody else will clear the
          // spinner this listing turned on.
          updatePane(id, { loading: false }, tabId);
          return;
        }
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
              // Listing the same folder again keeps what is still there selected.
              selected:
                (nextPath ?? pane.path) === pane.path
                  ? new Set(
                      result.entries
                        .map((entry) => entry.name)
                        .filter((name) => pane.selected.has(name)),
                    )
                  : new Set(),
              refreshedAt: Date.now(),
            },
            tabId,
          );
          const listingError = listingErrorRef.current;
          listingErrorRef.current = '';
          if (listingError) setErrorMessage((current) => (current === listingError ? '' : current));
        } else if (
          pane.kind === 'remote' &&
          pane.status === 'connected' &&
          (result.errorCode === 'connectionLost' ||
            result.errorCode === 'timedOut' ||
            (!result.errorCode && isConnectionLoss(result.error)))
        ) {
          // The connection is gone: the pane says so and offers to connect
          // again, instead of staying green and failing the same way each time.
          updatePane(
            id,
            {
              loading: false,
              status: 'error',
              errorMessage: friendlyError(commandResultError(result)) ?? '',
            },
            tabId,
          );
        } else {
          updatePane(id, { loading: false }, tabId);
          // A listing that lands after the user closed this session failed for
          // exactly the reason they asked for. Reporting it would blame the
          // server for a disconnect the user performed themselves.
          const closedOnPurpose =
            pane.kind === 'remote' && !!pane.connectionId && isConnectionDead(pane.connectionId);
          // Initial listing failures are shown by connectPane in the remote pane.
          if (!closedOnPurpose && (pane.kind !== 'remote' || pane.status !== 'connecting')) {
            listingErrorRef.current = friendlyError(commandResultError(result)) ?? '';
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
        if (localRequests.current.get(slotKey)?.controller === controller)
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

  const latestRef = useRef({ tabId: activeTabId, panes });
  latestRef.current = { tabId: activeTabId, panes };
  const refreshPaneIfAt = useCallback(
    (id: PaneId, path: string) => {
      const latest = latestRef.current;
      const pane = latest.panes[id];
      if (latest.tabId !== activeTabId || pane.path !== path) return Promise.resolve();
      return refreshPane(id, path, pane, activeTabId);
    },
    [activeTabId, refreshPane],
  );

  return { refreshPane, refreshPaneIfAt, ensureRequestIds, requestIdsRef, inFlightRefreshesRef };
}
