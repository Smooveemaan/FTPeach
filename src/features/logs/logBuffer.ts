import type { LogEntry } from '../../shared/types.ts';

export const MAX_LOG_LINES = 500;
export type StampedLogEntry<Entry extends object = LogEntry> = Entry & { id: number };

/** Retains only the newest entries without copying or stamping discarded history. */
export function appendLogBatch<Entry extends object>(
  previous: Array<StampedLogEntry<Entry>>,
  batch: Entry[],
  nextId: () => number,
  limit = MAX_LOG_LINES,
): Array<StampedLogEntry<Entry>> {
  if (!Number.isInteger(limit) || limit < 0)
    throw new RangeError('Log limit must be a non-negative integer');
  if (batch.length === 0 && previous.length <= limit) return previous;
  const retained = Math.min(batch.length, limit);
  const result =
    limit > retained ? previous.slice(-Math.min(previous.length, limit - retained)) : [];
  const skip = batch.length - retained;
  for (let index = 0; index < batch.length; index += 1) {
    const id = nextId();
    if (index >= skip) result.push({ ...batch[index]!, id });
  }
  return result;
}
