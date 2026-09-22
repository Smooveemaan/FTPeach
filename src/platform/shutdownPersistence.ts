/** Pending renderer writes that must settle before native shutdown. */
const writers = new Map<string, () => Promise<void>>();

/** Registers one state owner; replacing a mounted owner cannot remove its successor. */
export function registerShutdownWriter(name: string, flush: () => Promise<void>): () => void {
  writers.set(name, flush);
  return () => {
    if (writers.get(name) === flush) writers.delete(name);
  };
}

/** Attempts every owner even when one fails, then reports whether all writes settled. */
export async function flushShutdownState(): Promise<boolean> {
  const results = await Promise.allSettled(
    [...writers.values()].map((flush) => Promise.resolve().then(flush)),
  );
  return results.every((result) => result.status === 'fulfilled');
}
