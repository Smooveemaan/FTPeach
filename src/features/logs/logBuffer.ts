import type { LogEntry } from '../../shared/types.ts';

/** As many lines as the backend keeps in memory. */
export const MAX_LOG_LINES = 5000;
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
const sizes = new WeakMap<object, number>();

/** Bounds serialized text as well as record count, including pending history batches. */
export function boundLogBytes<Entry extends Sequenced>(
  entries: readonly Entry[],
): readonly Entry[] {
  let bytes = 0;
  let start = entries.length;
  while (start > 0) {
    const entry = entries[start - 1]!;
    let size = sizes.get(entry);
    if (size === undefined) {
      size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      sizes.set(entry, size);
    }
    if (bytes + size > MAX_LOG_BYTES) break;
    bytes += size;
    start -= 1;
  }
  return start === 0 ? entries : entries.slice(start);
}

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
  return boundLogBytes([...previous.slice(previous.length - kept), ...fresh]);
}

/**
 * Whether `batch` starts past the record after `afterSeq`: the listener
 * missed some, and the history has to be read again.
 */
export function hasLogGap(afterSeq: number, batch: readonly Sequenced[]): boolean {
  const first = batch[0];
  return first !== undefined && first.seq > afterSeq + 1;
}
