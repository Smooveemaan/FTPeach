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
  /** What a folder walk last reported putting in place on its target. */
  landed?: number | undefined;
  startedAt: number;
  errorMessage?: string | undefined;
  // Widened to `string` on purpose, and not narrowed to `CommandErrorCode`:
  // this field arrives across the IPC boundary, where the backend can send a
  // code this build does not know about. Consumers must handle that.
  errorCode?: string | undefined;
}
export type TransferRow = TransferBase &
  (
    | {
        direction: 'recursive';
        dragOut?: false;
        intent: RecursiveIntent;
        /** The remote target's protocol, which decides whether a pause can carry on. */
        targetProtocol?: SiteProtocol | undefined;
      }
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

/**
 * Uploads can only resume where the protocol can both append at an offset and
 * read the overlap back to prove appending is safe: SFTP writes and reads at an
 * offset, FTP and FTPS append with APPE and read with REST over the same
 * backend. WebDAV can do neither, because PUT has no standard partial write.
 */
const RESUMABLE_UPLOAD_PROTOCOLS: ReadonlySet<SiteProtocol> = new Set(['ftp', 'ftps', 'sftp']);

/**
 * Whether a transfer can be paused rather than only stopped.
 *
 * A pause promises the transfer will pick up where it left off, so it is
 * offered only where that can be honoured. Downloads resume from their local
 * partial on every protocol; uploads depend on the protocol above. A folder
 * walk keeps a journal of what it has delivered and carries on past it, but the
 * file the pause cut short carries on only where uploads resume, so a walk into
 * a WebDAV server cannot pause either. Nor can a move within one server: that
 * is a single rename, with nothing to pause. Relay copies have no resumable
 * stream at all, and a drag-out has no destination of ours to resume into.
 */
export function canPauseTransfer(row: TransferRow): boolean {
  if (row.dragOut) return false;
  if (row.direction === 'recursive') {
    const { moving, source, target } = row.intent;
    if (target.kind === 'local') return true;
    return (
      !(moving && source.kind === 'remote') &&
      row.targetProtocol !== undefined &&
      RESUMABLE_UPLOAD_PROTOCOLS.has(row.targetProtocol)
    );
  }
  return (
    row.direction !== 'copy' &&
    (row.direction !== 'up' || RESUMABLE_UPLOAD_PROTOCOLS.has(row.protocol))
  );
}

export function transferConnectionIds(row: TransferRow): string[] {
  if (row.direction === 'recursive') {
    return [row.intent.source, row.intent.target]
      .filter((endpoint) => endpoint.kind === 'remote')
      .map((endpoint) => endpoint.connectionId);
  }
  return row.direction === 'copy'
    ? [row.sourceConnectionId, row.targetConnectionId]
    : [row.connectionId];
}

export function transferTouchesConnection(row: TransferRow, connectionId: string): boolean {
  return transferConnectionIds(row).includes(connectionId);
}

/**
 * Connection ids are minted fresh by every connect (`createPaneSessionLifecycle`
 * never reissues one), so once a connection is torn down nothing bound to it
 * can ever come back to life. Recorded here so a row stuck pointing at a dead
 * connection can be told apart from one that can still be retried into a live
 * session.
 */
const deadConnectionIds = new Set<string>();

export function markConnectionDead(connectionId: string): void {
  if (deadConnectionIds.has(connectionId)) return;
  deadConnectionIds.add(connectionId);
  // Rows read this set through canRetryTransfer while rendering, so growing it
  // has to reach subscribers the way a row change would. A row already sitting
  // at error/stopped is not touched by the teardown that got us here, and would
  // otherwise keep offering a Retry until some unrelated transfer redrew it.
  setTransfersStore((previous) => ({ ...previous }));
}

/**
 * Whether this connection was torn down on purpose. Also the answer to "did
 * the server drop us, or did we hang up?" for anything that fails against a
 * connection afterwards — a listing that lands after the teardown failed for
 * the reason the user asked for, not for one worth reporting.
 */
export function isConnectionDead(connectionId: string): boolean {
  return deadConnectionIds.has(connectionId);
}

export function canRetryTransfer(row: TransferRow): boolean {
  return !transferConnectionIds(row).some(isConnectionDead);
}

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
  deadConnectionIds.clear();
}
