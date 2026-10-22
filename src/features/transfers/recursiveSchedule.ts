import { getTransferRow, subscribeTransfers } from './transferStore.ts';

export type RefreshCallback = () => unknown;

// Keep manifests bounded while every selected folder already has a queue row.
const recursiveSlots: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
let recursiveSlot = 0;
export function scheduleRecursive<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const slot = recursiveSlot++ % recursiveSlots.length;
  const result = recursiveSlots[slot]!.then(() => {
    signal.throwIfAborted();
    return run();
  });
  recursiveSlots[slot] = result.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error('Recursive transfer cancelled before dispatch'));
    signal.addEventListener('abort', cancel, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** How often, at most, a running folder walk lists its target again. */
const LANDED_REFRESH_INTERVAL_MS = 1000;

/**
 * Lists a folder walk's target again whenever the walk reports putting more in
 * place there, so its folders and finished files show up while it runs rather
 * than only once it ends. Spaced out, or a folder of many small files would
 * list the target once per file. Returns what stops following.
 */
export function followLanded(id: string, attemptId: string, refresh: RefreshCallback | undefined) {
  if (!refresh) return () => {};
  let seen = getTransferRow(id)?.landed;
  let lastRefresh = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribeTransfers(() => {
    const row = getTransferRow(id);
    if (row?.attemptId !== attemptId || row.landed === undefined || row.landed === seen) return;
    seen = row.landed;
    timer ??= setTimeout(
      () => {
        timer = undefined;
        lastRefresh = Date.now();
        refresh();
      },
      Math.max(0, lastRefresh + LANDED_REFRESH_INTERVAL_MS - Date.now()),
    );
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
