import { createFilesystemApi } from '../../../src/platform/api/filesystem.ts';
import { createSessionApi } from '../../../src/platform/api/session.ts';
import type { InvokeFn } from '../../../src/platform/ipcContracts.ts';

/** What `session_connect` answers when the connection opened. */
export const CONNECTED = { outcome: 'connected' };

/** What `session_connect` answers when the user has to decide about a host key. */
export const hostKeyUnconfirmed = (key: Record<string, unknown>) => ({
  outcome: 'hostKeyUnconfirmed',
  ...key,
});

/** One injected IPC transport, with real API response validation around it. */
export function paneClient(
  reply: (_command: string, _args: Record<string, unknown> | undefined) => unknown = (command) =>
    command === 'session_connect' ? CONNECTED : { ok: true },
) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const invoke: InvokeFn = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return (await reply(command, args)) as T;
  };
  return {
    calls,
    client: { fsLocal: createFilesystemApi(invoke), session: createSessionApi(invoke) },
  };
}
