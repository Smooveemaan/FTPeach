import type { SiteProtocol } from '../../shared/types.ts';
import type { RecursiveIntent } from '../../platform/api/transfers.ts';

export type TransferDirection = 'up' | 'down' | 'copy' | 'recursive';
export type TransferStatus =
  'cancelling' | 'queued' | 'progress' | 'paused' | 'stopped' | 'done' | 'error';
interface TransferBase {
  id: string;
  attemptId?: string;
  name: string;
  status: TransferStatus;
  bytes: number;
  total?: number | undefined;
  startedAt: number;
  errorMessage?: string | undefined;
  // Widened to `string` on purpose, and not narrowed to `CommandErrorCode`:
  // this field arrives across the IPC boundary, where the backend can send a
  // code this build does not know about. Consumers must handle that.
  errorCode?: string | undefined;
}
export type TransferRow = TransferBase &
  (
    | { direction: 'recursive'; dragOut?: false; intent: RecursiveIntent }
    | {
        direction: 'up';
        protocol: SiteProtocol;
        dragOut?: false;
        connectionId: string;
        localFile: string;
        remoteTarget: string;
      }
    | {
        direction: 'down';
        protocol: SiteProtocol;
        dragOut?: false;
        connectionId: string;
        remoteFile: string;
        localTarget: string;
      }
    | {
        direction: 'copy';
        protocol: SiteProtocol;
        dragOut?: false;
        sourceConnectionId: string;
        targetConnectionId: string;
        sourcePath: string;
        remoteTarget: string;
      }
    | {
        direction: 'down';
        protocol: SiteProtocol;
        /** Explorer owns the unknown destination; only cancellation is supported. */
        dragOut: true;
        isDirectory?: boolean | undefined;
        connectionId: string;
        remoteFile: string;
      }
  );
export type TransferInput = TransferRow extends infer Row
  ? Row extends TransferRow
    ? Omit<Row, 'id' | 'bytes' | 'status' | 'startedAt'>
    : never
  : never;
export type TransferState = Record<string, TransferRow>;
export type TransferStoreUpdater = TransferState | ((state: TransferState) => TransferState);

let state: TransferState = {};
const listeners = new Set<() => void>();
export const COMPLETED_RETENTION = 1000;
const attempts = new Map<string, string>();
const targets = new Map<string, string>();

export function transferTargetKey(row: TransferRow): string | undefined {
  if (row.dragOut) return undefined;
  if (row.direction === 'recursive') {
    const target = row.intent.target;
    return target.kind === 'local'
      ? `local:${target.path.replaceAll('/', '\\').toLowerCase()}`
      : `remote:${target.connectionId}:${target.path}`;
  }
  return row.direction === 'down'
    ? `local:${row.localTarget.replaceAll('/', '\\').toLowerCase()}`
    : `remote:${row.direction === 'up' ? row.connectionId : row.targetConnectionId}:${row.remoteTarget}`;
}

export function transferForAttempt(attempt: string): TransferRow | undefined {
  const id = attempts.get(attempt);
  return id === undefined ? undefined : state[id];
}

export function activeTransferForTarget(key: string): TransferRow | undefined {
  const id = targets.get(key);
  return id === undefined ? undefined : state[id];
}

export function getTransfersSnapshot(): TransferState {
  return state;
}

export function subscribeTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTransfersStore(updater: TransferStoreUpdater): void {
  const nextState = typeof updater === 'function' ? updater(state) : updater;
  if (Object.is(nextState, state)) return;
  const completed = Object.values(nextState).filter((row) => row.status === 'done');
  if (completed.length > COMPLETED_RETENTION) {
    completed.sort((a, b) => b.startedAt - a.startedAt);
    state = { ...nextState };
    for (const row of completed.slice(COMPLETED_RETENTION)) delete state[row.id];
  } else state = nextState;
  attempts.clear();
  targets.clear();
  for (const row of Object.values(state)) {
    attempts.set(row.attemptId || row.id, row.id);
    if (['queued', 'progress', 'cancelling'].includes(row.status)) {
      const key = transferTargetKey(row);
      if (key !== undefined) targets.set(key, row.id);
    }
  }
  listeners.forEach((listener) => listener());
}

export function resetTransfersStoreForTests(): void {
  state = {};
  attempts.clear();
  targets.clear();
}
