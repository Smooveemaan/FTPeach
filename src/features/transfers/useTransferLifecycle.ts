import { useRef } from 'react';
import type { TransferTarget } from './useOverwriteApproval.ts';
import { useTranslation } from 'react-i18next';
import { api } from '../../platform/api/index.ts';
import type { RecursiveIntent, RecursiveReport } from '../../platform/api/transfers.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { isCommandErrorCode } from '../../platform/ipcContracts.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import { joinLocalPath, joinRemotePath } from '../../shared/paths.ts';
import type { SiteProtocol } from '../../shared/types.ts';
import type { TransferInput, TransferStatus } from './transferStore.ts';
import {
  activeTransferForTarget,
  canPauseTransfer,
  canRetryTransfer,
  getTransfersSnapshot,
  markConnectionDead,
  setTransfersStore,
  transferTouchesConnection,
} from './transferStore.ts';
import { validateWindowsDownloadName } from './transferWalk.ts';
import { useTransferNotifications } from './useTransferNotifications.ts';
import { useTransferProgressAdapter } from './useTransferProgressAdapter.ts';

export type RefreshCallback = () => unknown;

let transferSequence = 0;

function nextTransferId() {
  const transfers = getTransfersSnapshot();
  let id: string;
  do {
    transferSequence += 1;
    id = `t${transferSequence}`;
  } while (id in transfers);
  return id;
}

/** Owns individual transfer state, retries, cancellation and queue-wide actions. */

export interface TransferLifecycleModel {
  runRecursive: (intent: RecursiveIntent, existingId?: string) => Promise<RecursiveReport>;
  runUpload: (
    connectionId: string,
    protocol: SiteProtocol,
    localFile: string,
    name: string,
    remoteTargetDir: string,
    _localSize?: number,
    /** The destination was already approved for overwrite; don't ask again. */
    overwriteApproved?: boolean,
  ) => Promise<
    | CommandResult
    | { ok: boolean; alreadyRunning: boolean; skipped?: never }
    | { ok: boolean; skipped: boolean; alreadyRunning?: never }
  >;
  runDownload: (
    connectionId: string,
    protocol: SiteProtocol,
    remoteFile: string,
    name: string,
    localTargetDir: string,
    resume?: boolean,
    /** The destination was already approved for overwrite; don't ask again. */
    overwriteApproved?: boolean,
  ) => Promise<
    | CommandResult
    | { ok: boolean; alreadyRunning: boolean; skipped?: never }
    | { ok: boolean; skipped: boolean; alreadyRunning?: never }
  >;
  runRemoteCopy: (
    sourceConnectionId: string,
    sourcePath: string,
    targetConnectionId: string,
    targetProtocol: SiteProtocol,
    name: string,
    targetTargetDir: string,
    /** The destination was already approved for overwrite; don't ask again. */
    overwriteApproved?: boolean,
  ) => Promise<
    | CommandResult
    | { ok: boolean; alreadyRunning: boolean; skipped?: never }
    | { ok: boolean; skipped: boolean; alreadyRunning?: never }
  >;
  retryTransfer: (id: string, refreshTarget?: RefreshCallback) => Promise<void>;
  pauseTransfer: (id: string) => Promise<void>;
  stopTransfer: (id: string) => Promise<void>;
  stopTransfersForConnection: (connectionId: string) => Promise<void[]>;
  pauseAllTransfers: () => void;
  stopAllTransfers: () => void;
  resumeAllTransfers: (refreshTargets?: RefreshCallback) => void;
  retryAllTransfers: (refreshTargets?: RefreshCallback) => void;
  clearCompletedTransfers: () => void;
}

export function useTransferLifecycle(
  setErrorMessage: (message?: string) => unknown,
  approveTarget: (target: TransferTarget) => Promise<boolean | null> = () => Promise.resolve(false),
): TransferLifecycleModel {
  const { t } = useTranslation();
  const cancelIntentRef = useRef<Record<string, TransferStatus>>({});

  useTransferNotifications(t);
  useTransferProgressAdapter(cancelIntentRef);

  const startTransfer = (input: TransferInput) => {
    const id = nextTransferId();
    setTransfersStore((previous) => ({
      ...previous,
      [id]: {
        id,
        ...input,
        bytes: 0,
        status: 'queued',
        startedAt: Date.now(),
      },
    }));
    return id;
  };

  const beginAttempt = (id: string) => {
    const attemptId = crypto.randomUUID();
    setTransfersStore((previous) => ({ ...previous, [id]: { ...previous[id]!, attemptId } }));
    return attemptId;
  };

  const settleTransferResult = (
    id: string,
    result: CommandResult,
    attemptId: string,
    _target: TransferTarget,
  ) => {
    if (getTransfersSnapshot()[id]?.attemptId !== attemptId) return;
    const intent = cancelIntentRef.current[id];
    if (!result.ok && !intent && result.errorCode !== 'cancelled') {
      setErrorMessage(friendlyError(commandResultError(result)) || undefined);
    }
    setTransfersStore((previous) =>
      previous[id]?.attemptId === attemptId
        ? {
            ...previous,
            [id]: {
              ...previous[id],
              status: result.ok ? 'done' : intent || 'error',
              errorCode: result.ok ? undefined : result.errorCode,
              errorMessage: result.ok ? undefined : result.error,
            },
          }
        : previous,
    );
  };

  const runUpload = async (
    connectionId: string,
    protocol: SiteProtocol,
    localFile: string,
    name: string,
    remoteTargetDir: string,
    _localSize?: number,
    overwriteApproved = false,
  ) => {
    const remoteTarget = joinRemotePath(remoteTargetDir, name);
    if (activeTransferForTarget(`remote:${connectionId}:${remoteTarget}`))
      return { ok: false, alreadyRunning: true };
    const overwrite = overwriteApproved
      ? true
      : await approveTarget({
          kind: 'remote',
          connectionId,
          path: remoteTarget,
          protocol,
        });
    if (overwrite === null) return { ok: false, skipped: true };
    const existing = Object.values(getTransfersSnapshot()).find(
      (item) =>
        item.direction === 'up' &&
        item.connectionId === connectionId &&
        item.localFile === localFile &&
        item.remoteTarget === remoteTarget &&
        item.status !== 'done',
    );
    if (
      existing?.status === 'progress' ||
      existing?.status === 'queued' ||
      existing?.status === 'cancelling'
    ) {
      // Reuse the queue row only after its current upload has settled.
      return { ok: false, alreadyRunning: true };
    }
    // Starting an upload always stages fresh, superseding anything a previous
    // paused attempt left for this destination. Resuming is retryTransfer's.
    const resume = false;

    const id =
      existing?.id ||
      startTransfer({ direction: 'up', name, protocol, localFile, remoteTarget, connectionId });
    if (existing) {
      delete cancelIntentRef.current[id];
      setTransfersStore((previous) => {
        const row = previous[id];
        if (!row) return previous;
        return {
          ...previous,
          [id]: {
            ...row,
            bytes: 0,
            status: 'queued',
            errorMessage: undefined,
            errorCode: undefined,
          },
        };
      });
    }
    const attemptId = beginAttempt(id);
    const result = await api.transfer.upload(
      connectionId,
      attemptId,
      localFile,
      remoteTarget,
      resume,
      overwrite,
    );
    settleTransferResult(id, result, attemptId, {
      kind: 'remote',
      connectionId,
      path: remoteTarget,
    });
    return result;
  };

  const runDownload = async (
    connectionId: string,
    protocol: SiteProtocol,
    remoteFile: string,
    name: string,
    localTargetDir: string,
    resume = true,
    overwriteApproved = false,
  ) => {
    validateWindowsDownloadName(name);
    const localTarget = joinLocalPath(localTargetDir, name);
    if (activeTransferForTarget(`local:${localTarget.replaceAll('/', '\\').toLowerCase()}`))
      return { ok: false, alreadyRunning: true };
    const overwrite = overwriteApproved
      ? true
      : await approveTarget({ kind: 'local', path: localTarget });
    if (overwrite === null) return { ok: false, skipped: true };
    const existing = Object.values(getTransfersSnapshot()).find(
      (item) =>
        item.direction === 'down' &&
        !item.dragOut &&
        item.connectionId === connectionId &&
        item.remoteFile === remoteFile &&
        item.localTarget === localTarget &&
        item.status !== 'done',
    );
    if (
      existing?.status === 'progress' ||
      existing?.status === 'queued' ||
      existing?.status === 'cancelling'
    ) {
      // Keep this row attached to its running backend attempt.
      return { ok: false, alreadyRunning: true };
    }

    const id =
      existing?.id ||
      startTransfer({ direction: 'down', name, protocol, remoteFile, localTarget, connectionId });
    if (existing) {
      delete cancelIntentRef.current[id];
      setTransfersStore((previous) => {
        const row = previous[id];
        if (!row) return previous;
        return {
          ...previous,
          [id]: { ...row, status: 'queued', errorMessage: undefined, errorCode: undefined },
        };
      });
    }
    const attemptId = beginAttempt(id);
    const result = await api.transfer.download(
      connectionId,
      attemptId,
      remoteFile,
      localTarget,
      resume,
      overwrite,
    );
    settleTransferResult(id, result, attemptId, { kind: 'local', path: localTarget });
    return result;
  };

  const runRemoteCopy = async (
    sourceConnectionId: string,
    sourcePath: string,
    targetConnectionId: string,
    targetProtocol: SiteProtocol,
    name: string,
    targetTargetDir: string,
    overwriteApproved = false,
  ) => {
    const targetPath = joinRemotePath(targetTargetDir, name);
    if (activeTransferForTarget(`remote:${targetConnectionId}:${targetPath}`))
      return { ok: false, alreadyRunning: true };
    const overwrite = overwriteApproved
      ? true
      : await approveTarget({
          kind: 'remote',
          connectionId: targetConnectionId,
          protocol: targetProtocol,
          path: targetPath,
        });
    if (overwrite === null) return { ok: false, skipped: true };
    const id = startTransfer({
      direction: 'copy',
      name,
      protocol: targetProtocol,
      sourceConnectionId,
      sourcePath,
      targetConnectionId,
      remoteTarget: targetPath,
    });
    const attemptId = beginAttempt(id);
    const result = await api.transfer.remoteCopy(
      sourceConnectionId,
      targetConnectionId,
      attemptId,
      sourcePath,
      targetPath,
      overwrite,
    );
    settleTransferResult(id, result, attemptId, {
      kind: 'remote',
      connectionId: targetConnectionId,
      path: targetPath,
    });
    return result;
  };

  const runRecursive = async (intent: RecursiveIntent, existingId?: string) => {
    const id =
      existingId || startTransfer({ direction: 'recursive', name: intent.source.path, intent });
    const attemptId = beginAttempt(id);
    setTransfersStore((previous) => ({
      ...previous,
      [id]: { ...previous[id]!, status: 'progress' },
    }));
    let report: RecursiveReport;
    try {
      report = await api.transfer.recursive({ ...intent, id: attemptId });
    } catch (error) {
      report = {
        ok: false,
        outcome: 'failed',
        scanned: 0,
        completed: 0,
        errors: [{ message: String(error) }],
      };
    }
    settleTransferResult(
      id,
      {
        ok: report.ok,
        error: report.errors.map((error) => error.message).join('\n'),
        errorCode: isCommandErrorCode(report.errors[0]?.code) ? report.errors[0].code : undefined,
      },
      attemptId,
      { kind: intent.target.kind, path: intent.target.path },
    );
    return report;
  };

  const retryTransfer = async (id: string, refreshTarget?: RefreshCallback) => {
    const transfer = getTransfersSnapshot()[id];
    // A drag-out download's destination is Explorer's, unknown to us — there
    // is nothing to retry into. The user simply drags again.
    if (
      !transfer ||
      transfer.dragOut ||
      ['queued', 'progress', 'cancelling', 'done'].includes(transfer.status) ||
      !canRetryTransfer(transfer)
    )
      return;
    delete cancelIntentRef.current[id];
    if (transfer.direction === 'recursive') {
      await runRecursive(transfer.intent, id);
      refreshTarget?.();
      return;
    }
    // An upload resumes only from a deliberate pause: every other ending has
    // already discarded its staging file on the server, so there is nothing
    // left to append to and the attempt would silently restart anyway.
    const resume =
      transfer.direction === 'down'
        ? transfer.status === 'paused' ||
          (transfer.status === 'error' && transfer.errorCode !== 'integrityMismatch')
        : transfer.direction === 'up' && canPauseTransfer(transfer) && transfer.status === 'paused';
    setTransfersStore((previous) => {
      const row = previous[id];
      if (!row) return previous;
      return {
        ...previous,
        [id]: {
          ...row,
          status: 'queued',
          bytes: resume ? row.bytes : 0,
          errorMessage: undefined,
          errorCode: undefined,
        },
      };
    });
    const attemptId = beginAttempt(id);
    let overwrite: boolean | null;
    try {
      overwrite = await approveTarget(
        transfer.direction === 'down'
          ? { kind: 'local', path: transfer.localTarget }
          : {
              kind: 'remote',
              protocol: transfer.protocol,
              connectionId:
                transfer.direction === 'up' ? transfer.connectionId : transfer.targetConnectionId,
              path: transfer.remoteTarget,
            },
      );
    } catch (error) {
      settleTransferResult(id, { ok: false, error: String(error) }, attemptId, {
        kind: 'local',
        path: '',
      });
      return;
    }
    if (overwrite === null || cancelIntentRef.current[id]) {
      setTransfersStore((previous) => ({
        ...previous,
        [id]: { ...previous[id]!, status: 'stopped' },
      }));
      return;
    }
    if (transfer.direction === 'up') {
      const result = await api.transfer.upload(
        transfer.connectionId,
        attemptId,
        transfer.localFile,
        transfer.remoteTarget,
        resume,
        overwrite,
      );
      settleTransferResult(id, result, attemptId, {
        kind: 'remote',
        connectionId: transfer.connectionId,
        path: transfer.remoteTarget,
      });
    } else if (transfer.direction === 'copy') {
      // Relay copies cannot be paused, so retries always start from scratch.
      const result = await api.transfer.remoteCopy(
        transfer.sourceConnectionId,
        transfer.targetConnectionId,
        attemptId,
        transfer.sourcePath,
        transfer.remoteTarget,
        overwrite,
      );
      settleTransferResult(id, result, attemptId, {
        kind: 'remote',
        connectionId: transfer.targetConnectionId,
        path: transfer.remoteTarget,
      });
    } else {
      const result = await api.transfer.download(
        transfer.connectionId,
        attemptId,
        transfer.remoteFile,
        transfer.localTarget,
        resume,
        overwrite,
      );
      settleTransferResult(id, result, attemptId, { kind: 'local', path: transfer.localTarget });
    }
    refreshTarget?.();
  };

  const requestCancel = async (id: string, intent: 'paused' | 'stopped') => {
    const current = getTransfersSnapshot()[id];
    if (!current || ['done', 'error', 'stopped'].includes(current.status)) return;
    const wasRunning = current.status === 'progress' || current.status === 'queued';
    cancelIntentRef.current[id] = intent;
    setTransfersStore((previous) =>
      previous[id] &&
      (previous[id].status === 'progress' ||
        previous[id].status === 'queued' ||
        previous[id].status === 'paused')
        ? { ...previous, [id]: { ...previous[id], status: wasRunning ? 'cancelling' : intent } }
        : previous,
    );
    if (wasRunning) {
      if (current.direction === 'recursive') {
        await api.transfer.cancelRecursive(current.attemptId || id);
      } else if (current.direction === 'copy') {
        await api.transfer.cancelRemoteCopy(
          current.sourceConnectionId,
          current.targetConnectionId,
          current.attemptId || id,
        );
      } else {
        await api.transfer.cancel(
          current.connectionId,
          current.attemptId || id,
          intent === 'paused' ? 'pause' : 'stop',
        );
      }
    }
  };

  // canPauseTransfer is the only authority on this: a row may end up marked "paused"
  // only if it can genuinely be resumed, whoever asked. Anything else degrades
  // to a stop instead of offering a resume that would silently start over.
  const pauseTransfer = (id: string) => {
    const transfer = getTransfersSnapshot()[id];
    return requestCancel(id, transfer && canPauseTransfer(transfer) ? 'paused' : 'stopped');
  };
  const stopTransfer = (id: string) => requestCancel(id, 'stopped');

  // Disconnecting a pane tears down its session out from under any transfer
  // still using it. Cancel those transfers the same way "Stop" would first, so
  // they resolve as user-cancelled instead of racing the teardown and
  // surfacing as a spurious connection-lost error.
  //
  // Everything settles as stopped, including rows already sitting at "paused":
  // a connection id is never reissued — reconnecting mints a fresh one — so
  // nothing bound to this one can be resumed once it is gone. The server side
  // agrees: teardown deletes the staging file every paused upload would append
  // to. A row left claiming "paused" would be a promise to resume that can only
  // fail, so the honest ending is a stop.
  const stopTransfersForConnection = (connectionId: string) => {
    markConnectionDead(connectionId);
    return Promise.all(
      Object.values(getTransfersSnapshot())
        .filter(
          (transfer) =>
            !['done', 'error', 'stopped'].includes(transfer.status) &&
            transferTouchesConnection(transfer, connectionId),
        )
        .map((transfer) => requestCancel(transfer.id, 'stopped')),
    );
  };

  const idsWithStatus = (...statuses: TransferStatus[]) =>
    Object.values(getTransfersSnapshot())
      .filter((transfer) => statuses.includes(transfer.status))
      .map((transfer) => transfer.id);
  const pauseAllTransfers = () =>
    idsWithStatus('progress', 'queued')
      .filter((id) => {
        const transfer = getTransfersSnapshot()[id];
        return transfer !== undefined && canPauseTransfer(transfer);
      })
      .forEach((id) => reportRejection(pauseTransfer(id)));
  const stopAllTransfers = () =>
    idsWithStatus('progress', 'queued', 'paused', 'cancelling').forEach((id) =>
      reportRejection(stopTransfer(id)),
    );
  const resumeAllTransfers = (refreshTargets?: RefreshCallback) =>
    idsWithStatus('paused').forEach((id) => reportRejection(retryTransfer(id, refreshTargets)));
  const retryAllTransfers = (refreshTargets?: RefreshCallback) =>
    idsWithStatus('error', 'stopped').forEach((id) =>
      reportRejection(retryTransfer(id, refreshTargets)),
    );
  const clearCompletedTransfers = () => {
    setTransfersStore((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([, transfer]) =>
            transfer.status !== 'done' &&
            transfer.status !== 'error' &&
            transfer.status !== 'stopped',
        ),
      ),
    );
  };

  return {
    runRecursive,
    runUpload,
    runDownload,
    runRemoteCopy,
    retryTransfer,
    pauseTransfer,
    stopTransfer,
    stopTransfersForConnection,
    pauseAllTransfers,
    stopAllTransfers,
    resumeAllTransfers,
    retryAllTransfers,
    clearCompletedTransfers,
  };
}
