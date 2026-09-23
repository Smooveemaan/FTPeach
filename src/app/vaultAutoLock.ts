interface VaultActivityApi {
  noteActivity: () => void;
}
interface DocumentTarget {
  addEventListener: (
    name: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) => unknown;
  removeEventListener: (name: string, listener: EventListener) => unknown;
}
interface Clock {
  now: () => number;
}
interface VaultActivityOptions {
  vault: VaultActivityApi;
  documentTarget?: DocumentTarget;
  clock?: Clock;
}

/**
 * How long one report covers. The backend measures idleness in whole
 * minutes, so reporting more often than this only adds IPC traffic; at the
 * shortest idle timeout the user can set it still costs the vault less than
 * a second of accuracy.
 */
const REPORT_INTERVAL_MS = 30_000;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

/**
 * Tells the backend when the user has been seen.
 *
 * The idle timeout, the clock and the decision to lock all live in the
 * backend (`security::auto_lock`), which is what makes the vault's
 * protection survive a renderer that has stopped running its timers. This
 * side only reports; failing to report lets the vault lock sooner, never
 * later, so there is nothing here to retry or to recover from.
 */
export function installVaultActivityReporting({
  vault,
  documentTarget = document,
  clock = { now: () => Date.now() },
}: VaultActivityOptions): () => void {
  let reportedAt = Number.NEGATIVE_INFINITY;
  const report = () => {
    const now = clock.now();
    if (now - reportedAt < REPORT_INTERVAL_MS) return;
    reportedAt = now;
    vault.noteActivity();
  };

  for (const event of ACTIVITY_EVENTS) {
    documentTarget.addEventListener(event, report, { passive: true });
  }
  report();

  return () => {
    for (const event of ACTIVITY_EVENTS) {
      documentTarget.removeEventListener(event, report);
    }
  };
}
