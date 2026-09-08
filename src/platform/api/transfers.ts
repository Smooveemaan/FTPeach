import {
  checkedResponse,
  commandFailure,
  commandOutcome,
  isCommandRecord,
  isDragOutTransferStarted,
  isTransferProgress,
} from '../ipcContracts.ts';
import type { EventRegistrar, InvokeFn } from '../ipcContracts.ts';

export type RecursiveEndpoint =
  { kind: 'local'; path: string } | { kind: 'remote'; path: string; connectionId: string };
export interface RecursiveIntent {
  id: string;
  source: RecursiveEndpoint;
  target: RecursiveEndpoint;
  moving: boolean;
  overwrite: boolean;
  skipExisting?: boolean;
}
export interface RecursiveReport {
  ok: boolean;
  outcome: 'complete' | 'partial' | 'failed';
  scanned: number;
  completed: number;
  skipped?: number;
  errors: { message: string; code?: string }[];
}
function isRecursiveReport(value: unknown): value is RecursiveReport {
  return (
    isCommandRecord(value) &&
    typeof value.ok === 'boolean' &&
    ['complete', 'partial', 'failed'].includes(String(value.outcome)) &&
    typeof value.scanned === 'number' &&
    typeof value.completed === 'number' &&
    Array.isArray(value.errors) &&
    value.errors.every(
      (error) =>
        isCommandRecord(error) &&
        typeof error.message === 'string' &&
        (error.code === undefined || typeof error.code === 'string'),
    )
  );
}

export function createTransferApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    recursive: async (intent: RecursiveIntent): Promise<RecursiveReport> => {
      let authorizationToken: string | undefined;
      if (intent.moving && intent.source.kind === 'local') {
        const grant = await invoke('plugin:sensitive|authorize_sensitive', {
          operation: 'fs_delete',
          target: intent.source.path,
        });
        if (!isCommandRecord(grant) || typeof grant.token !== 'string') {
          return {
            ok: false,
            outcome: 'failed',
            scanned: 0,
            completed: 0,
            errors: [
              {
                message:
                  commandFailure('authorize_sensitive', grant).error || 'Authorization failed',
              },
            ],
          };
        }
        authorizationToken = grant.token;
      }
      return checkedResponse(
        'transfer_recursive',
        invoke('transfer_recursive', { intent, authorizationToken }),
        isRecursiveReport,
        (raw) => ({
          ok: false,
          outcome: 'failed',
          scanned: 0,
          completed: 0,
          errors: [
            {
              message:
                commandFailure('transfer_recursive', raw).error || 'Recursive operation failed',
            },
          ],
        }),
      );
    },
    cancelRecursive: (id: string) => invoke('transfer_cancel_recursive', { id }),
    validateRemoteCopy: (
      sourcePath: string,
      targetPath: string,
      sourceConnectionId: string,
      targetConnectionId: string,
      moving: boolean,
    ) =>
      commandOutcome(invoke, 'transfer_validate_remote_copy', {
        sourcePath,
        targetPath,
        sourceConnectionId,
        targetConnectionId,
        moving,
      }),
    upload: (
      connectionId: string,
      transferId: string,
      localPath: string,
      remotePath: string,
      resume: boolean,
      overwrite = false,
    ) =>
      commandOutcome(invoke, 'transfer_upload', {
        connectionId,
        transferId,
        localPath,
        remotePath,
        resume,
        overwrite,
      }),
    download: (
      connectionId: string,
      transferId: string,
      remotePath: string,
      localPath: string,
      resume: boolean,
      overwrite = false,
    ) =>
      commandOutcome(invoke, 'transfer_download', {
        connectionId,
        transferId,
        remotePath,
        localPath,
        resume,
        overwrite,
      }),
    cancel: (connectionId: string, transferId: string) =>
      invoke('transfer_cancel', { connectionId, transferId }),
    remoteCopy: (
      sourceConnectionId: string,
      targetConnectionId: string,
      transferId: string,
      sourcePath: string,
      targetPath: string,
      overwrite = false,
    ) =>
      commandOutcome(invoke, 'transfer_remote_copy', {
        sourceConnectionId,
        targetConnectionId,
        transferId,
        sourcePath,
        targetPath,
        overwrite,
      }),
    cancelRemoteCopy: (
      sourceConnectionId: string,
      targetConnectionId: string,
      transferId: string,
    ) =>
      invoke('transfer_cancel_remote_copy', { sourceConnectionId, targetConnectionId, transferId }),
    onProgress: onEvent('transfer:progress', isTransferProgress),
    onDragOutStarted: onEvent('transfer:dragOutStarted', isDragOutTransferStarted),
  };
}
