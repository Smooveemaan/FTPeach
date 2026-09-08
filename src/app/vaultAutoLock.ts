interface VaultStatus {
  configured: boolean;
  locked: boolean;
}
interface VaultApi {
  status: () => Promise<VaultStatus>;
  lock: () => Promise<{ ok?: boolean } | null | undefined>;
}
interface DocumentTarget {
  visibilityState: string;
  addEventListener: (
    name: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) => unknown;
  removeEventListener: (name: string, listener: EventListener) => unknown;
}
interface TimerTarget {
  setTimeout: (handler: () => void | Promise<void>, timeout: number) => number;
  clearTimeout: (id: number | undefined) => unknown;
}
interface VaultAutoLockOptions {
  minutes: number;
  vault: VaultApi;
  documentTarget?: DocumentTarget;
  timerTarget?: TimerTarget;
  onLocked?: () => void;
}

export function installVaultAutoLock({
  minutes,
  vault,
  documentTarget = document,
  timerTarget = window,
  onLocked = () => {},
}: VaultAutoLockOptions): () => void {
  if (!(minutes > 0)) return () => {};

  let timer: number | undefined;
  let stopped = false;

  const lockVault = async () => {
    if (stopped) return;
    const status = await vault.status();
    // `stopped` is set by the returned teardown, which the compiler does not model.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (stopped || !status.configured || status.locked) return;
    const result = await vault.lock();
    if (result?.ok === false) return;
    onLocked();
  };
  const resetTimer = () => {
    timerTarget.clearTimeout(timer);
    timer = timerTarget.setTimeout(lockVault, minutes * 60_000);
  };
  const lockWhenProtected = () => {
    if (documentTarget.visibilityState === 'hidden') void lockVault();
  };
  const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

  for (const event of activityEvents) {
    documentTarget.addEventListener(event, resetTimer, { passive: true });
  }
  documentTarget.addEventListener('visibilitychange', lockWhenProtected);
  resetTimer();

  return () => {
    stopped = true;
    timerTarget.clearTimeout(timer);
    for (const event of activityEvents) {
      documentTarget.removeEventListener(event, resetTimer);
    }
    documentTarget.removeEventListener('visibilitychange', lockWhenProtected);
  };
}
