import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type {
  CommandResult,
  OpenWithChange,
  PreviewProgress,
} from '../../platform/ipcContracts.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import type { PaneId } from '../../shared/types.ts';

interface ConnectionTab {
  panes: Record<PaneId, { kind: string; status: string; connectionId: string | null }>;
}

export interface OpenWithTarget {
  path: string;
  size?: number | undefined;
  connectionId: string;
  paneId: PaneId;
  tabId: string;
}

export interface OpenWithWatch {
  localPath: string;
  remotePath: string;
  name: string;
  connectionId: string;
  paneId: PaneId;
  tabId: string;
}

export interface OpenWithOpened {
  id: string;
  localPath: string;
  remotePath: string;
}

interface OpenWithApi {
  stop: (id: string) => Promise<unknown>;
  onChanged: (callback: (payload: OpenWithChange) => void) => () => void;
  onProgress: (callback: (payload: PreviewProgress) => void) => () => void;
  start: (
    connectionId: string,
    remotePath: string,
    id: string,
    application: string | null,
  ) => Promise<CommandResult & { localPath?: string }>;
}

export function collectLiveConnectionIds(tabs: readonly ConnectionTab[]): Set<string> {
  return new Set(
    tabs.flatMap((tab) =>
      (['a', 'b'] as const)
        .filter(
          (paneId) =>
            tab.panes[paneId].kind === 'remote' && tab.panes[paneId].status === 'connected',
        )
        .map((paneId) => tab.panes[paneId].connectionId)
        .filter((id): id is string => id != null),
    ),
  );
}

export interface OpenWithLifecycleModel {
  target: OpenWithTarget | null;
  setTarget: Dispatch<SetStateAction<OpenWithTarget | null>>;
  watches: Record<string, OpenWithWatch>;
  changedId: string | null;
  setChangedId: Dispatch<SetStateAction<string | null>>;
  registerOpened: ({ id, localPath, remotePath }: OpenWithOpened) => void;
}

export function useOpenWithLifecycle(
  tabs: readonly ConnectionTab[],
  openWithApi: OpenWithApi = api.openWith,
): OpenWithLifecycleModel {
  const [target, setTarget] = useState<OpenWithTarget | null>(null);
  const [watches, setWatches] = useState<Record<string, OpenWithWatch>>({});
  const [changedId, setChangedId] = useState<string | null>(null);
  const watchesRef = useRef(watches);
  watchesRef.current = watches;

  useEffect(
    () =>
      openWithApi.onChanged(({ id }) => {
        if (watchesRef.current[id]) setChangedId((current) => current ?? id);
      }),
    [openWithApi],
  );

  useEffect(() => {
    const liveConnectionIds = collectLiveConnectionIds(tabs);
    const staleIds = Object.entries(watchesRef.current)
      .filter(([, watch]) => !liveConnectionIds.has(watch.connectionId))
      .map(([id]) => id);
    if (staleIds.length === 0) return;

    staleIds.forEach((id) => reportRejection(openWithApi.stop(id)));
    setChangedId((current) => (current && staleIds.includes(current) ? null : current));
    setWatches((currentWatches) => {
      const next = { ...currentWatches };
      staleIds.forEach((id) => delete next[id]);
      return next;
    });
  }, [openWithApi, tabs]);

  const registerOpened = useCallback(
    ({ id, localPath, remotePath }: OpenWithOpened) => {
      if (!target) return;
      const name = remotePath.split('/').filter(Boolean).pop() || remotePath;
      setWatches((current) => ({
        ...current,
        [id]: {
          localPath,
          remotePath,
          name,
          connectionId: target.connectionId,
          paneId: target.paneId,
          tabId: target.tabId,
        },
      }));
      setTarget(null);
    },
    [target],
  );

  return {
    target,
    setTarget,
    watches,
    changedId,
    setChangedId,
    registerOpened,
  };
}
