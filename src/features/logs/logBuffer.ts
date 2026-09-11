import type { LogEntry } from '../../shared/types.ts';

/** As many lines as the backend keeps in memory. */
export const MAX_LOG_LINES = 5000;

type Sequenced = Pick<LogEntry, 'seq'>;

/**
 * Appends the entries numbered after `afterSeq`, keeping only the newest
 * `limit`. The backend numbers records in order, so whatever `log_recent`
 * already returned, or the user cleared, and a live batch repeats is dropped.
 * Returns `previous` itself when nothing changes.
 */
export function mergeLogBatch<Entry extends Sequenced>(
  previous: readonly Entry[],
  batch: readonly Entry[],
  afterSeq: number,
  limit = MAX_LOG_LINES,
): readonly Entry[] {
  if (!Number.isInteger(limit) || limit < 0)
    throw new RangeError('Log limit must be a non-negative integer');
  const firstNew = batch.findIndex((entry) => entry.seq > afterSeq);
  if (firstNew === -1 && previous.length <= limit) return previous;
  const fresh = firstNew === -1 ? [] : batch.slice(Math.max(firstNew, batch.length - limit));
  const kept = Math.min(previous.length, limit - fresh.length);
  return [...previous.slice(previous.length - kept), ...fresh];
}

/**
 * Whether `batch` starts past the record after `afterSeq`: the listener
 * missed some, and the history has to be read again.
 */
export function hasLogGap(afterSeq: number, batch: readonly Sequenced[]): boolean {
  const first = batch[0];
  return first !== undefined && first.seq > afterSeq + 1;
}
