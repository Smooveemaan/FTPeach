/**
 * Copies the interface's warnings and errors into the application log file
 * (`ftpeach-app.log`), next to the backend's own records, so a user's report
 * can carry what went wrong on this side as well. The console still gets them.
 */

type LogInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

// tauri-plugin-log's levels.
const WARN = 4;
const ERROR = 5;
const MAX_MESSAGE_LENGTH = 8 * 1024;
const RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_SECOND = 20;
const REPEAT_FLUSH_MS = 2_000;

interface ForwarderClock {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

const DEFAULT_CLOCK: ForwarderClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface ConsoleForwarder {
  forward: (level: number, values: readonly unknown[]) => void;
  dispose: () => void;
}

export function describeConsoleArguments(values: readonly unknown[]): string {
  const text = values
    .map((value) => {
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (typeof value === 'string') return value;
      // JSON.stringify returns undefined for the first three and throws on a bigint.
      if (
        value === undefined ||
        typeof value === 'function' ||
        typeof value === 'symbol' ||
        typeof value === 'bigint'
      )
        return String(value);
      try {
        return JSON.stringify(value);
      } catch {
        return '[unserializable object]';
      }
    })
    .join(' ');
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

/**
 * Rate-limits and collapses consecutive identical console messages before
 * sending them over IPC, so a tight render/error loop cannot flood the log.
 */
export function createConsoleForwarder(
  invoke: LogInvoke,
  clock: ForwarderClock = DEFAULT_CLOCK,
): ConsoleForwarder {
  let forwarding = false;
  let disposed = false;
  let windowStart = clock.now();
  let sentInWindow = 0;
  let droppedInWindow = 0;
  let pending: { level: number; message: string; repeats: number } | null = null;
  let repeatTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearRepeatTimer = () => {
    if (repeatTimer !== null) {
      clock.clearTimeout(repeatTimer);
      repeatTimer = null;
    }
  };

  const emit = (level: number, message: string) => {
    if (disposed) return;
    const now = clock.now();
    let droppedNote = '';
    if (now - windowStart >= RATE_WINDOW_MS) {
      if (droppedInWindow > 0) {
        droppedNote = ` (dropped ${droppedInWindow} rate-limited console messages)`;
        droppedInWindow = 0;
      }
      windowStart = now;
      sentInWindow = 0;
    }
    if (sentInWindow >= MAX_MESSAGES_PER_SECOND) {
      droppedInWindow += 1;
      return;
    }
    sentInWindow += 1;
    void invoke('plugin:log|log', {
      level,
      message: droppedNote ? `${message}${droppedNote}` : message,
      location: 'console',
    }).catch(() => {});
  };

  const flushPending = () => {
    clearRepeatTimer();
    const current = pending;
    pending = null;
    if (current && current.repeats > 0) {
      emit(current.level, `${current.message} (repeated ${current.repeats} times)`);
    }
  };

  const forward = (level: number, values: readonly unknown[]) => {
    // A failure inside the forwarding itself must not come back around.
    if (forwarding || disposed) return;
    forwarding = true;
    try {
      const message = describeConsoleArguments(values);
      if (pending && pending.level === level && pending.message === message) {
        pending.repeats += 1;
        if (repeatTimer === null) {
          repeatTimer = clock.setTimeout(() => {
            repeatTimer = null;
            if (forwarding || disposed) return;
            forwarding = true;
            try {
              flushPending();
            } catch {
              // Nothing to report it to.
            } finally {
              forwarding = false;
            }
          }, REPEAT_FLUSH_MS);
        }
        return;
      }

      flushPending();
      pending = { level, message, repeats: 0 };
      emit(level, message);
    } catch {
      // Nothing to report it to.
    } finally {
      forwarding = false;
    }
  };

  const dispose = () => {
    disposed = true;
    clearRepeatTimer();
    pending = null;
  };

  return { forward, dispose };
}

export function installConsoleForwarding(invoke: LogInvoke): () => void {
  const forwarder = createConsoleForwarder(invoke);

  const { error, warn } = console;
  console.error = (...values: unknown[]) => {
    error.apply(console, values);
    forwarder.forward(ERROR, values);
  };
  console.warn = (...values: unknown[]) => {
    warn.apply(console, values);
    forwarder.forward(WARN, values);
  };
  const onError = (event: ErrorEvent) => {
    forwarder.forward(ERROR, [event.error ?? event.message]);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    forwarder.forward(ERROR, ['Unhandled rejection:', event.reason]);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    forwarder.dispose();
    console.error = error;
    console.warn = warn;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
