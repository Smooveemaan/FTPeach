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

export function installConsoleForwarding(invoke: LogInvoke): () => void {
  let forwarding = false;
  const forward = (level: number, values: readonly unknown[]) => {
    // A failure inside the forwarding itself must not come back around.
    if (forwarding) return;
    forwarding = true;
    try {
      void invoke('plugin:log|log', {
        level,
        message: describeConsoleArguments(values),
        location: 'console',
      }).catch(() => {});
    } catch {
      // Nothing to report it to.
    } finally {
      forwarding = false;
    }
  };

  const { error, warn } = console;
  console.error = (...values: unknown[]) => {
    error.apply(console, values);
    forward(ERROR, values);
  };
  console.warn = (...values: unknown[]) => {
    warn.apply(console, values);
    forward(WARN, values);
  };
  const onError = (event: ErrorEvent) => {
    forward(ERROR, [event.error ?? event.message]);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    forward(ERROR, ['Unhandled rejection:', event.reason]);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    console.error = error;
    console.warn = warn;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
