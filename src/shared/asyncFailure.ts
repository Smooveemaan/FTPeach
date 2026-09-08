/**
 * One place for the question "this promise rejected — now what?".
 *
 * The app is almost entirely asynchronous IPC, and a rejected IPC call
 * that nobody handles produces nothing at all: no retry, no message, no log
 * entry. The user sees an action that appears to have worked and hasn't. These
 * helpers make the answer explicit at every call site, so `no-floating-promises`
 * and `no-misused-promises` can be enforced as errors.
 *
 * The sink is registered once by `useApplicationError`, rather than threaded
 * through as a parameter, because the alternative is passing a callback down
 * through hooks that have no other reason to know about error reporting
 * (`useSectionResize` is eight layers from the error banner). There is exactly
 * one error banner in the app, so a single registration point matches reality.
 * This is not application state — nothing re-renders because of it — so it does
 * not reopen the deliberate no-Context decision about state flow.
 */
type FailureSink = (error: unknown) => void;

let sink: FailureSink | null = null;

/**
 * Points {@link reportAsyncFailure} at the live error banner. Returns a
 * disposer so a re-registration (or an unmounting test render) cannot leave a
 * stale reporter pointing at a dead component.
 */
export function setAsyncFailureSink(next: FailureSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function reportAsyncFailure(error: unknown): void {
  if (sink) {
    sink(error);
    return;
  }
  // Before the app mounts, and in unit tests that render a hook in isolation,
  // there is no banner to write to. Losing the failure entirely is the one
  // outcome worth avoiding.
  console.error('Unreported async failure', error);
}

/**
 * Starts a promise whose failure must reach the user, without making the caller
 * async. Use where the caller genuinely cannot await — a React setState updater,
 * a DOM event handler, a drag callback.
 */
export function reportRejection(promise: Promise<unknown>): void {
  void promise.catch(reportAsyncFailure);
}

/**
 * Adapts an async function to the `void`-returning shape event handlers and
 * other callbacks expect, reporting a rejection instead of leaving it unhandled.
 *
 * Without this, `onClick={async () => …}` turns a failed action into an
 * unhandled rejection: the user clicks, nothing happens, nothing explains why.
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
): (...args: Args) => void {
  return (...args: Args) => {
    try {
      const result = fn(...args);
      if (result instanceof Promise) void result.catch(reportAsyncFailure);
    } catch (error) {
      reportAsyncFailure(error);
    }
  };
}
