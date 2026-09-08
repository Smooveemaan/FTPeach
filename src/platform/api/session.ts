import {
  checkedResponse,
  commandFailure,
  commandOutcome,
  hasCommandOutcome,
  isRecord,
} from '../ipcContracts.ts';
import type { CommandResult, InvokeFn } from '../ipcContracts.ts';
import type { FileEntry } from '../../shared/types.ts';

export type ConnectionConfig = Record<string, unknown> & { protocol: string };
export interface SessionConnectResult extends CommandResult {
  hostKeyMismatch?: { host: string; port: number };
}
export interface SessionListResult extends CommandResult {
  entries: FileEntry[];
}

function isFileEntry(value: unknown): value is FileEntry {
  return isRecord(value) && typeof value.name === 'string';
}

function isSessionListResult(value: unknown): value is SessionListResult {
  return (
    hasCommandOutcome(value) && Array.isArray(value.entries) && value.entries.every(isFileEntry)
  );
}

function isSessionConnectResult(value: unknown): value is SessionConnectResult {
  if (!hasCommandOutcome(value)) return false;
  const mismatch = value.hostKeyMismatch;
  return (
    mismatch === undefined ||
    (isRecord(mismatch) && typeof mismatch.host === 'string' && typeof mismatch.port === 'number')
  );
}

export function createSessionApi(invoke: InvokeFn) {
  return {
    connect: (connectionId: string, config: ConnectionConfig): Promise<SessionConnectResult> =>
      checkedResponse(
        'session_connect',
        invoke('session_connect', { connectionId, config }),
        isSessionConnectResult,
        (raw) => commandFailure('session_connect', raw),
      ),
    cancelConnect: (connectionId: string) => invoke('session_cancel_connect', { connectionId }),
    disconnect: (connectionId: string) => invoke('session_disconnect', { connectionId }),
    list: (connectionId: string, remotePath: string): Promise<SessionListResult> =>
      checkedResponse(
        'session_list',
        invoke('session_list', { connectionId, remotePath }),
        isSessionListResult,
        (raw) => ({ ...commandFailure('session_list', raw), entries: [] }),
      ),
    mkdir: (connectionId: string, remotePath: string) =>
      commandOutcome(invoke, 'session_mkdir', { connectionId, remotePath }),
    createFile: (connectionId: string, remotePath: string) =>
      commandOutcome(invoke, 'session_create_file', { connectionId, remotePath }),
    delete: (connectionId: string, remotePath: string, isDir: boolean) =>
      commandOutcome(invoke, 'session_delete', { connectionId, remotePath, isDir }),
    rename: (connectionId: string, oldPath: string, newPath: string, overwrite?: boolean) =>
      commandOutcome(invoke, 'session_rename', {
        connectionId,
        oldPath,
        newPath,
        ...(overwrite === undefined ? {} : { overwrite }),
      }),
    chmod: (connectionId: string, remotePath: string, mode: string) =>
      commandOutcome(invoke, 'session_chmod', { connectionId, remotePath, mode }),
    forgetHostKey: (host: string, port: number) =>
      commandOutcome(invoke, 'session_forget_host_key', { host, port }),
  };
}
