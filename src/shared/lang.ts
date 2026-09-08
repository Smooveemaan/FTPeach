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

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One iterator shared by every worker: each `next()` hands out a distinct
  // [index, item] pair, so no worker has to index the array by a counter.
  const queue = items.entries();
  async function worker() {
    for (const [index, item] of queue) {
      results[index] = await fn(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
