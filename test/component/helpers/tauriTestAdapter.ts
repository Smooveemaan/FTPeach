/* global window */
import { vi } from 'vitest';

type InvokeArgs = Record<string, unknown> | undefined;
type InvokeHandler = unknown | Error | ((_args: InvokeArgs) => unknown | Promise<unknown>);
type InvokeOverrides = Record<string, InvokeHandler>;

interface InvokeCall {
  command: string;
  args: InvokeArgs;
}

interface TauriTestWindow extends Window {
  __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> };
  __TAURI__?: { event: { listen: ReturnType<typeof vi.fn> } };
}

export function installTauriTestAdapter(overrides: InvokeOverrides = {}) {
  const calls: InvokeCall[] = [];
  const invoke = vi.fn(async (command: string, args?: InvokeArgs) => {
    calls.push({ command, args });
    const handler = overrides[command];
    if (handler instanceof Error) throw handler;
    return typeof handler === 'function' ? handler(args) : handler;
  });
  const listen = vi.fn(async (_event: string, _callback: (_event: unknown) => void) => vi.fn());

  const testWindow = window as TauriTestWindow;
  testWindow.__TAURI_INTERNALS__ = { invoke };
  testWindow.__TAURI__ = { event: { listen } };
  return { invoke, listen, calls };
}
