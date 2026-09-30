import {
  checkedResponse,
  commandFailure,
  isFileEntry,
  isRecord,
  voidOutcome,
} from '../ipcContracts.ts';
import type { CommandResult, HostKeyDecision, InvokeFn } from '../ipcContracts.ts';
import type { FileEntry } from '../../shared/paneContracts.ts';
import type { ServerSettings } from '../../shared/siteContracts.ts';

/** What to open: a saved site, which the backend reads itself, or a typed-in server. */
export type ConnectRequest =
  | { kind: 'savedSite'; siteId: string }
  | {
      kind: 'direct';
      server: ServerSettings;
      credentials: { password: string; keyPassphrase: string };
    };

/**
 * The two connection settings the window sends with every connect, because
 * the settings dialog applies them while it previews them, before they are
 * saved. The backend reads the rest of the connection settings itself.
 */
export interface WindowConnectionSettings {
  timeoutMs: number;
  activeMode: boolean;
}
export interface SessionConnectResult extends CommandResult {
  hostKeyMismatch?: HostKeyDecision;
}
export interface SessionListResult extends CommandResult {
  entries: FileEntry[];
}

function isFileEntryArray(value: unknown): value is FileEntry[] {
  return Array.isArray(value) && value.every(isFileEntry);
}

/** How `session_connect` ended when it did not fail. */
type ConnectOutcome =
  { outcome: 'connected' } | ({ outcome: 'hostKeyUnconfirmed' } & HostKeyDecision);

function isConnectOutcome(value: unknown): value is ConnectOutcome {
  if (!isRecord(value)) return false;
  if (value.outcome === 'connected') return true;
  return (
    value.outcome === 'hostKeyUnconfirmed' &&
    typeof value.host === 'string' &&
    typeof value.port === 'number' &&
    typeof value.actual === 'string' &&
    (value.expected === undefined || typeof value.expected === 'string')
  );
}

/**
 * A host key the connection would not accept on its own is a decision, not a
 * failure. Its one caller reads it from a failed result: `ok: false` with the
 * key to confirm.
 */
function connectResult(outcome: ConnectOutcome): SessionConnectResult {
  if (outcome.outcome === 'connected') return { ok: true };
  const { outcome: _outcome, ...hostKeyMismatch } = outcome;
  return { ok: false, errorCode: 'hostKeyMismatch', hostKeyMismatch };
}

export function createSessionApi(invoke: InvokeFn) {
  return {
    connect: (
      connectionId: string,
      request: ConnectRequest,
      settings: WindowConnectionSettings,
    ): Promise<SessionConnectResult> =>
      checkedResponse(
        'session_connect',
        invoke('session_connect', { connectionId, request, settings }),
        isConnectOutcome,
        (raw) => commandFailure('session_connect', raw),
      ).then((result) => ('outcome' in result ? connectResult(result) : result)),
    cancelConnect: (connectionId: string) =>
      voidOutcome(invoke, 'session_cancel_connect', { connectionId }),
    disconnect: (connectionId: string) =>
      voidOutcome(invoke, 'session_disconnect', { connectionId }),
    list: (connectionId: string, remotePath: string): Promise<SessionListResult> =>
      checkedResponse(
        'session_list',
        invoke('session_list', { connectionId, remotePath }),
        isFileEntryArray,
        (raw): SessionListResult => ({ ...commandFailure('session_list', raw), entries: [] }),
      ).then((entries) => (Array.isArray(entries) ? { ok: true, entries } : entries)),
    mkdir: (connectionId: string, remotePath: string) =>
      voidOutcome(invoke, 'session_mkdir', { connectionId, remotePath }),
    createFile: (connectionId: string, remotePath: string) =>
      voidOutcome(invoke, 'session_create_file', { connectionId, remotePath }),
    delete: (connectionId: string, remotePath: string, isDir: boolean) =>
      voidOutcome(invoke, 'session_delete', { connectionId, remotePath, isDir }),
    rename: (connectionId: string, oldPath: string, newPath: string, overwrite: boolean) =>
      voidOutcome(invoke, 'session_rename', {
        connectionId,
        oldPath,
        newPath,
        overwrite,
      }),
    chmod: (connectionId: string, remotePath: string, mode: string) =>
      voidOutcome(invoke, 'session_chmod', { connectionId, remotePath, mode }),
    /**
     * Trusts one exact host key for one exact server, after the backend's
     * own window has shown both fingerprints. `expected` is the pinned
     * fingerprint, absent on a first connection.
     */
    trustHostKey: (request: HostKeyDecision) =>
      voidOutcome(invoke, 'session_trust_host_key', {
        request: JSON.stringify(
          request.expected === undefined
            ? { host: request.host, port: request.port, actual: request.actual }
            : request,
        ),
      }),
  };
}
