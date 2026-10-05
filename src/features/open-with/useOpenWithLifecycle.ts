import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type {
  CommandResult,
  OpenWithChange,
  PreviewProgress,
} from '../../platform/ipcContracts.ts';
import { reportAsyncFailure, reportRejection } from '../../shared/asyncFailure.ts';
import { commandResultError } from '../../shared/errorMessages.ts';
import type { PaneId } from '../../shared/paneContracts.ts';

interface ConnectionTab {
  panes: Record<PaneId, { kind: string; status: string; connectionId: string | null }>;
}

export interface OpenWithTarget {
  path: string;
  /** The program the user just chose; otherwise the extension's association. */
  application?: string | undefined;
  /** Windows' own chooser picks the program, the association is not used. */
  choose?: boolean | undefined;
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
  markSynced: (id: string, revision: string) => Promise<CommandResult>;
  onChanged: (callback: (payload: OpenWithChange) => void) => () => void;
  onProgress: (callback: (payload: PreviewProgress) => void) => () => void;
  start: (
    connectionId: string,
    remotePath: string,
    id: string,
    application: string | null,
  ) => Promise<CommandResult & { localPath?: string }>;
}

const sameChange = (a: OpenWithChange, b: OpenWithChange) =>
  a.id === b.id && a.revision === b.revision;

/** Queues `change`, replacing an older revision of the same copy in place. */
export function enqueueChange(
  queue: readonly OpenWithChange[],
  change: OpenWithChange,
): OpenWithChange[] {
  return queue.some((queued) => queued.id === change.id)
    ? queue.map((queued) => (queued.id === change.id ? change : queued))
    : [...queue, change];
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
  /** The oldest change still waiting for an answer. */
  changed: OpenWithChange | null;
  /** Closes the question about `change`; the copy keeps its unsynced edits. */
  dismissChanged: (change: OpenWithChange) => void;
  /** Records that exactly this revision is now on the server. */
  confirmUploaded: (change: OpenWithChange) => void;
  /** Asks about a change again after its upload failed. */
  retryChanged: (change: OpenWithChange) => void;
  /** This copy's upload has started; its later revisions wait for it. */
  uploadStarted: (change: OpenWithChange) => void;
  /** The upload settled, whatever the outcome; the copy can be asked about again. */
  uploadSettled: (change: OpenWithChange) => void;
  registerOpened: ({ id, localPath, remotePath }: OpenWithOpened) => void;
}

export function useOpenWithLifecycle(
  tabs: readonly ConnectionTab[],
  openWithApi: OpenWithApi = api.openWith,
): OpenWithLifecycleModel {
  const [target, setTarget] = useState<OpenWithTarget | null>(null);
  const [watches, setWatches] = useState<Record<string, OpenWithWatch>>({});
  // One entry per copy, in the order the copies changed. A newer revision
  // replaces the queued one in place, so every edited copy is asked about
  // once and none is lost while another question is open.
  const [pending, setPending] = useState<OpenWithChange[]>([]);
  // Copies whose upload is in flight. The question closes as soon as the user
  // answers it, so a save made while the upload runs would otherwise be asked
  // about immediately and refused, because a transfer to that same file is
  // already active — leaving the user to click Upload until it happens to go
  // through. The newer revision waits here instead and is asked about once.
  const [uploading, setUploading] = useState<Record<string, true>>({});
  const watchesRef = useRef(watches);
  watchesRef.current = watches;

  useEffect(
    () =>
      openWithApi.onChanged(({ id, revision }) => {
        if (watchesRef.current[id]) setPending((queue) => enqueueChange(queue, { id, revision }));
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
    setPending((queue) => queue.filter((change) => !staleIds.includes(change.id)));
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
      // A reused copy keeps the pane that first opened it: its edits go up
      // through that connection, and stop being watched when it closes.
      setWatches((current) => ({
        [id]: {
          localPath,
          remotePath,
          name,
          connectionId: target.connectionId,
          paneId: target.paneId,
          tabId: target.tabId,
        },
        ...current,
      }));
      setTarget(null);
    },
    [target],
  );

  const dismissChanged = useCallback((change: OpenWithChange) => {
    setPending((queue) => queue.filter((queued) => !sameChange(queued, change)));
  }, []);

  const retryChanged = useCallback((change: OpenWithChange) => {
    // A copy no longer watched has no question to show; its edits wait for
    // recovery instead of blocking the queue.
    if (!watchesRef.current[change.id]) return;
    setPending((queue) =>
      queue.some((queued) => queued.id === change.id) ? queue : [...queue, change],
    );
  }, []);

  const uploadStarted = useCallback((change: OpenWithChange) => {
    setUploading((current) => ({ ...current, [change.id]: true }));
  }, []);

  const uploadSettled = useCallback((change: OpenWithChange) => {
    setUploading((current) => {
      if (!current[change.id]) return current;
      const next = { ...current };
      delete next[change.id];
      return next;
    });
  }, []);

  const confirmUploaded = useCallback(
    (change: OpenWithChange) =>
      reportRejection(
        openWithApi
          .markSynced(change.id, change.revision)
          .then((result) => {
            if (!result.ok) {
              retryChanged(change);
              reportAsyncFailure(commandResultError(result));
            }
          })
          .catch((error: unknown) => {
            retryChanged(change);
            throw error;
          }),
      ),
    [openWithApi, retryChanged],
  );

  return {
    target,
    setTarget,
    watches,
    changed: pending.find((change) => !uploading[change.id]) ?? null,
    dismissChanged,
    confirmUploaded,
    retryChanged,
    uploadStarted,
    uploadSettled,
    registerOpened,
  };
}
