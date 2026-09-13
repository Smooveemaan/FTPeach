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
let exposed = false;
const listeners = new Set<() => void>();
const structureListeners = new Set<() => void>();
const rowListeners = new Map<string, Set<() => void>>();
const activeIds = new Set<string>();
const progressIds = new Set<string>();
let revision = 0;
let structureRevision = 0;
let idsCache: { revision: number; ids: string[] } | undefined;
let publishTimer: ReturnType<typeof setTimeout> | undefined;
const pendingRows = new Set<string>();
let structurePending = false;
const counts = {
  total: 0,
  active: 0,
  cancelling: 0,
  paused: 0,
  pausable: 0,
  completed: 0,
  retryable: 0,
};
export interface TransferSummary {
  transfersEmpty: boolean;
  hasCompletedTransfers: boolean;
  hasActiveTransfers: boolean;
  activeTransfersCount: number;
  hasPausableTransfers: boolean;
  hasPausedTransfers: boolean;
  canResumeAllTransfers: boolean;
  hasRetryableTransfers: boolean;
}
let summary: TransferSummary = makeSummary();

function makeSummary(): TransferSummary {
  return {
    transfersEmpty: counts.total === 0,
    hasCompletedTransfers: counts.completed > 0,
    hasActiveTransfers: counts.active > 0,
    activeTransfersCount: counts.active,
    hasPausableTransfers: counts.pausable > 0,
    hasPausedTransfers: counts.paused > 0,
    canResumeAllTransfers: counts.paused > 0 && counts.pausable === 0 && counts.cancelling === 0,
    hasRetryableTransfers: counts.retryable > 0,
  };
}
function isActive(row: TransferRow): boolean {
  return ['queued', 'progress', 'cancelling'].includes(row.status);
}
function countRow(row: TransferRow, delta: number): void {
  counts.total += delta;
  if (isActive(row)) counts.active += delta;
  if (row.status === 'cancelling') counts.cancelling += delta;
  if (row.status === 'paused') counts.paused += delta;
  if (['queued', 'progress'].includes(row.status) && canPauseTransfer(row))
    counts.pausable += delta;
  if (['done', 'error', 'stopped'].includes(row.status)) counts.completed += delta;
  if (['error', 'stopped'].includes(row.status) && canRetryTransfer(row)) counts.retryable += delta;
}
function refreshSummary(): void {
  const next = makeSummary();
  if (
    Object.keys(next).some(
      (key) => next[key as keyof TransferSummary] !== summary[key as keyof TransferSummary],
    )
  )
    summary = next;
}
export const getTransferSummarySnapshot = (): TransferSummary => summary;
export const getTransferRevision = (): number => revision;
export const getTransferStructureRevision = (): number => structureRevision;
export const getTransferRow = (id: string): TransferRow | undefined => state[id];
export const getActiveTransferIds = (): ReadonlySet<string> => activeIds;
export const getProgressTransferIds = (): ReadonlySet<string> => progressIds;
export function getTransferIds(): readonly string[] {
  if (idsCache?.revision !== structureRevision)
    idsCache = { revision: structureRevision, ids: Object.keys(state) };
  return idsCache.ids;
}
export function subscribeTransferStructure(listener: () => void): () => void {
  structureListeners.add(listener);
  return () => {
    structureListeners.delete(listener);
  };
}
export function subscribeTransferRow(id: string, listener: () => void): () => void {
  let group = rowListeners.get(id);
  if (!group) rowListeners.set(id, (group = new Set()));
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) rowListeners.delete(id);
  };
}
export function flushTransferUpdates(): void {
  clearTimeout(publishTimer);
  publishTimer = undefined;
  if (!pendingRows.size && !structurePending) return;
  const changed = [...pendingRows];
  const structural = structurePending;
  pendingRows.clear();
  structurePending = false;
  revision++;
  if (structural) structureListeners.forEach((listener) => listener());
  for (const id of changed) rowListeners.get(id)?.forEach((listener) => listener());
  listeners.forEach((listener) => listener());
}
function publish(deferred = false): void {
  if (deferred) publishTimer ??= setTimeout(flushTransferUpdates, 16);
  else flushTransferUpdates();
}
export const COMPLETED_RETENTION = 1000;
export const PENDING_TRANSFER_LIMIT = 1000;
export const TRANSFER_RESOURCE_LIMIT = 10_000;
/** Admission control only: never evict an existing active or paused operation. */
export function hasTransferCapacity(adding = true): boolean {
  return (
    counts.active < PENDING_TRANSFER_LIMIT && (!adding || counts.total < TRANSFER_RESOURCE_LIMIT)
  );
}
const attempts = new Map<string, string>();
const targets = new Map<string, Set<string>>();

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
  for (const row of Object.values(state)) countRow(row, -1);
  deadConnectionIds.add(connectionId);
  // Rows read this set through canRetryTransfer while rendering, so growing it
  // has to reach subscribers the way a row change would. A row already sitting
  // at error/stopped is not touched by the teardown that got us here, and would
  // otherwise keep offering a Retry until some unrelated transfer redrew it.
  for (const row of Object.values(state)) {
    countRow(row, 1);
    if (transferTouchesConnection(row, connectionId)) {
      if (exposed) {
        state = { ...state };
        exposed = false;
      }
      const id = attempts.get(row.attemptId || row.id)!;
      state[id] = { ...row };
      pendingRows.add(id);
    }
  }
  refreshSummary();
  structureRevision++;
  structurePending = true;
  publish();
  pruneConnectionMemory();
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

/**
 * The name each connection was last shown under while it was open. A row stays
 * in the list long after its connection closes and still has to say which
 * server it went to; ids are never reissued (see above), so a name remembered
 * here can never end up on some other server's row.
 */
const connectionLabelMemory = new Map<string, string>();
const connectionRequests = new Map<string, number>();
let liveLabelIds = new Set<string>();

function pruneConnectionMemory(): void {
  const referenced = new Set(liveLabelIds);
  for (const row of Object.values(state)) {
    for (const id of transferConnectionIds(row)) referenced.add(id);
  }
  for (const id of connectionRequests.keys()) referenced.add(id);
  for (const id of deadConnectionIds) if (!referenced.has(id)) deadConnectionIds.delete(id);
  for (const id of connectionLabelMemory.keys()) {
    if (!referenced.has(id)) connectionLabelMemory.delete(id);
  }
}

/** Keep disconnect suppression alive until the last pending response settles. */
export function retainConnectionRequest(connectionId: string): () => void {
  connectionRequests.set(connectionId, (connectionRequests.get(connectionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (connectionRequests.get(connectionId) ?? 1) - 1;
    if (count) connectionRequests.set(connectionId, count);
    else connectionRequests.delete(connectionId);
    pruneConnectionMemory();
  };
}

export function rememberConnectionLabels(labels: ReadonlyMap<string, string>): void {
  liveLabelIds = new Set(labels.keys());
  for (const [connectionId, label] of labels) connectionLabelMemory.set(connectionId, label);
  pruneConnectionMemory();
}

export function rememberedConnectionLabel(connectionId: string): string | undefined {
  return connectionLabelMemory.get(connectionId);
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
  const id = targets.get(key)?.values().next().value;
  return id === undefined ? undefined : state[id];
}

export function getTransfersSnapshot(): TransferState {
  exposed = true;
  return state;
}

export function subscribeTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keeps the newest COMPLETED_RETENTION rows among `statuses`. Successes and
 * failures are capped apart, so a burst of finished uploads never pushes out
 * an error nobody has looked at yet.
 */
function retainNewest(next: TransferState, statuses: readonly TransferStatus[]): TransferState {
  const finished = Object.values(next).filter((row) => statuses.includes(row.status));
  if (finished.length <= COMPLETED_RETENTION) return next;
  finished.sort((a, b) => b.startedAt - a.startedAt);
  const retained = { ...next };
  for (const row of finished.slice(COMPLETED_RETENTION)) delete retained[row.id];
  return retained;
}

export function setTransfersStore(updater: TransferStoreUpdater): void {
  let nextState = typeof updater === 'function' ? updater(getTransfersSnapshot()) : updater;
  if (Object.is(nextState, state)) return;
  nextState = retainNewest(retainNewest(nextState, ['done']), ['error', 'stopped']);
  for (const id of new Set([...Object.keys(state), ...Object.keys(nextState)])) {
    replaceRow(id, nextState[id]);
  }
  publish();
  pruneConnectionMemory();
}

function sameRow(a: TransferRow | undefined, b: TransferRow | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (key) => a[key as keyof TransferRow] === b[key as keyof TransferRow],
  );
}
function replaceRow(id: string, row: TransferRow | undefined): boolean {
  const previous = state[id];
  if (sameRow(previous, row)) return false;
  if (exposed) {
    state = { ...state };
    exposed = false;
  }
  const structural =
    !previous ||
    !row ||
    Object.keys({ ...previous, ...row }).some(
      (key) =>
        !['bytes', 'total', 'landed'].includes(key) &&
        previous[key as keyof TransferRow] !== row[key as keyof TransferRow],
    );
  if (structural) {
    if (previous) {
      countRow(previous, -1);
      if (attempts.get(previous.attemptId || previous.id) === id)
        attempts.delete(previous.attemptId || previous.id);
      const target = transferTargetKey(previous);
      if (target) {
        const owners = targets.get(target);
        owners?.delete(id);
        if (!owners?.size) targets.delete(target);
      }
      activeIds.delete(id);
      progressIds.delete(id);
    }
    if (row) {
      countRow(row, 1);
      if (row.status === 'progress') progressIds.add(id);
      attempts.set(row.attemptId || row.id, id);
      if (isActive(row)) {
        activeIds.add(id);
        const target = transferTargetKey(row);
        if (target) {
          let owners = targets.get(target);
          if (!owners) targets.set(target, (owners = new Set()));
          owners.add(id);
        }
      }
    }
    structureRevision++;
    structurePending = true;
    refreshSummary();
  }
  if (row) state[id] = row;
  else delete state[id];
  pendingRows.add(id);
  return true;
}

/** Hot path: touch one row, keeping indexes and summary stable for byte-only updates. */
export function updateTransferRow(
  id: string,
  update: (row: TransferRow) => TransferRow,
  deferred = false,
): void {
  const previous = state[id];
  if (!previous) return;
  const next = update(previous);
  if (!replaceRow(id, next)) {
    if (!deferred) publish();
    return;
  }
  // Retention and reference cleanup belong to lifecycle changes, never progress ticks.
  if (next.status !== previous.status && ['done', 'error', 'stopped'].includes(next.status)) {
    setTransfersStore({ ...state });
  }
  publish(deferred);
}

export function resetTransfersStoreForTests(): void {
  clearTimeout(publishTimer);
  publishTimer = undefined;
  pendingRows.clear();
  structurePending = false;
  exposed = false;
  activeIds.clear();
  progressIds.clear();
  revision = 0;
  structureRevision = 0;
  idsCache = undefined;
  for (const key of Object.keys(counts)) counts[key as keyof typeof counts] = 0;
  summary = makeSummary();
  state = {};
  attempts.clear();
  targets.clear();
  deadConnectionIds.clear();
  connectionLabelMemory.clear();
  connectionRequests.clear();
  liveLabelIds.clear();
}
