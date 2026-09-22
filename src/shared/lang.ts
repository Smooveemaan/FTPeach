// Small language-level helpers with no domain of their own.

/**
 * Reads a key that came from outside this build — an IPC error code, a file
 * extension out of a listing — from a table with literal keys. Casting the key
 * to `keyof T` would have the compiler promise a hit the runtime cannot make;
 * this returns `undefined` for a key the table does not have, which is true,
 * and so keeps the caller's fallback a required branch rather than dead code.
 */
export function lookupByUnknownKey<T extends object>(
  table: T,
  key: string | undefined,
): T[keyof T] | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key as keyof T] : undefined;
}

/** What one item of a batch did, in the order the items were given. */
export type SettledItem<R> =
  | { status: 'fulfilled'; value: R }
  | { status: 'rejected'; reason: unknown }
  | { status: 'skipped' };

export interface MapSettledOptions {
  /**
   * Whether a failure stops further items from being admitted. On by default:
   * these batches move and delete files, and a whole selection is rarely worth
   * pushing through a destination that has just refused one of them. It never
   * abandons a task already in flight.
   */
  stopOnError?: boolean;
}

/**
 * Runs `fn` over `items`, at most `limit` at a time, and returns what each item
 * did — including the ones never admitted.
 *
 * This never settles before every task it started has finished. A batch built
 * on `Promise.all` does: the first rejection hands control back to the caller
 * while other workers are still writing files, so the refresh, the cleared
 * clipboard and the count the user is shown all describe a batch that is still
 * running.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
  { stopOnError = true }: MapSettledOptions = {},
): Promise<Array<SettledItem<R>>> {
  const results = new Array<SettledItem<R>>(items.length);
  // One iterator shared by every worker: each `next()` hands out a distinct
  // [index, item] pair, so no worker has to index the array by a counter.
  const queue = items.entries();
  let stopped = false;
  async function worker() {
    for (const [index, item] of queue) {
      if (stopped) {
        results[index] = { status: 'skipped' };
        continue;
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(item, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
        if (stopOnError) stopped = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * {@link mapSettled} for a caller that wants the values and a throw: the first
 * failure is rethrown, but only once every task that had started has finished.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const settled = await mapSettled(items, limit, fn);
  const failed = settled.find((item) => item.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return settled.map((item) => (item.status === 'fulfilled' ? item.value : (undefined as R)));
}
