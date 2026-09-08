import type { MutableRefObject } from 'react';
import { useEffect } from 'react';
import { api } from '../../platform/api/index.ts';
import { friendlyError } from '../../shared/errorMessages.ts';
import type { TransferRow, TransferStatus } from './transferStore.ts';
import { setTransfersStore, transferForAttempt } from './transferStore.ts';

export function useTransferProgressAdapter(
  cancelIntentRef: MutableRefObject<Record<string, TransferStatus>>,
): void {
  useEffect(
    () =>
      api.transfer.onProgress((payload) => {
        setTransfersStore((previous) => {
          const existing = transferForAttempt(payload.id);
          if (!existing || (existing.attemptId && existing.status === 'cancelling'))
            return previous;
          const status =
            existing.attemptId && payload.status !== 'progress'
              ? existing.status
              : (cancelIntentRef.current[existing.id] ?? payload.status);
          return {
            ...previous,
            [existing.id]: {
              ...existing,
              bytes: payload.bytes ?? existing.bytes,
              total: payload.total ?? existing.total,
              status,
              errorMessage:
                status === 'error'
                  ? friendlyError(
                      payload.errorCode
                        ? { code: payload.errorCode, message: payload.error }
                        : payload.error,
                    ) || undefined
                  : existing.errorMessage,
              errorCode: status === 'error' ? payload.errorCode : existing.errorCode,
            },
          };
        });
      }),
    [cancelIntentRef],
  );

  // Native drag-out downloads are started by the OS, not by us, so their
  // queue rows are created from the backend's announcement rather than by
  // runDownload. Progress then flows through the handler above as usual.
  useEffect(
    () =>
      api.transfer.onDragOutStarted((payload) => {
        setTransfersStore((previous) => {
          if (previous[payload.id]) return previous;
          const row: TransferRow = {
            id: payload.id,
            direction: 'down',
            name: payload.name,
            protocol: payload.protocol,
            status: 'progress',
            bytes: 0,
            total: payload.total,
            startedAt: Date.now(),
            connectionId: payload.connectionId,
            remoteFile: payload.remoteFile,
            dragOut: true,
            isDirectory: payload.isDirectory,
          };
          return { ...previous, [payload.id]: row };
        });
      }),
    [],
  );
}
