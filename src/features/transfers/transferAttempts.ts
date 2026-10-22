import type { MutableRefObject } from 'react';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import type { Translate } from '../../shared/translate.ts';
import type { TransferInput, TransferStatus } from './transferStore.ts';
import {
  getTransferRow,
  getTransfersSnapshot,
  hasTransferCapacity,
  PENDING_TRANSFER_LIMIT,
  setTransfersStore,
} from './transferStore.ts';
import type { TransferTarget } from './useOverwriteApproval.ts';

let transferSequence = 0;

function nextTransferId() {
  const transfers = getTransfersSnapshot();
  let id: string;
  do {
    transferSequence += 1;
    id = `t${transferSequence}`;
  } while (id in transfers);
  return id;
}

interface TransferAttemptsOptions {
  t: Translate;
  /** Pause or stop the user asked for, by row. */
  cancelIntentRef: MutableRefObject<Record<string, TransferStatus>>;
  /** What each row put in the error banner, taken back if a retry succeeds. */
  shownErrors: MutableRefObject<Map<string, string>>;
  setErrorMessage: (message?: string) => unknown;
  withdrawErrorMessage: (message: string) => void;
}

/**
 * A queue row's life: created, given an attempt, put back in the queue for
 * another one, and settled by the result of the attempt that is still its own.
 */
export function createTransferAttempts({
  t,
  cancelIntentRef,
  shownErrors,
  setErrorMessage,
  withdrawErrorMessage,
}: TransferAttemptsOptions) {
  const startTransfer = (input: TransferInput) => {
    if (!hasTransferCapacity())
      throw new Error(t('transferQueue.capacity', { limit: PENDING_TRANSFER_LIMIT }));
    const id = nextTransferId();
    setTransfersStore((previous) => ({
      ...previous,
      [id]: {
        id,
        ...input,
        bytes: 0,
        status: 'queued',
        startedAt: Date.now(),
      },
    }));
    return id;
  };

  const beginAttempt = (id: string, overwrite?: boolean) => {
    const attemptId = crypto.randomUUID();
    setTransfersStore((previous) => ({
      ...previous,
      [id]: { ...previous[id]!, attemptId, ...(overwrite === undefined ? {} : { overwrite }) },
    }));
    return attemptId;
  };

  /**
   * Puts an existing row back in the queue for a new attempt: admission
   * against the queue limit, the old cancel intent and error dropped, and a
   * fresh attempt id in the same update, so progress from the attempt before
   * cannot land on this one. `keepBytes` is for a download or a paused
   * upload that carries on where it stopped; anything else starts over.
   */
  const requeueAttempt = (
    id: string,
    { keepBytes, overwrite }: { keepBytes: boolean; overwrite?: boolean },
  ) => {
    if (!hasTransferCapacity(false))
      throw new Error(t('transferQueue.capacity', { limit: PENDING_TRANSFER_LIMIT }));
    delete cancelIntentRef.current[id];
    const attemptId = crypto.randomUUID();
    setTransfersStore((previous) => {
      const row = previous[id];
      if (!row) return previous;
      return {
        ...previous,
        [id]: {
          ...row,
          attemptId,
          status: 'queued',
          bytes: keepBytes ? row.bytes : 0,
          ...(overwrite === undefined ? {} : { overwrite }),
          errorMessage: undefined,
          errorCode: undefined,
        },
      };
    });
    return attemptId;
  };

  const settleTransferResult = (
    id: string,
    result: CommandResult,
    attemptId: string,
    _target: TransferTarget,
    /** Says more than the error code alone would. */
    notice?: string,
  ) => {
    if (getTransferRow(id)?.attemptId !== attemptId) return false;
    const intent = cancelIntentRef.current[id];
    const message = result.ok
      ? undefined
      : (notice ?? (friendlyError(commandResultError(result)) || undefined));
    if (!result.ok && !intent && result.errorCode !== 'cancelled') {
      setErrorMessage(message);
      if (message) shownErrors.current.set(id, message);
    }
    const shown = shownErrors.current.get(id);
    if (result.ok && shown !== undefined) {
      shownErrors.current.delete(id);
      withdrawErrorMessage(shown);
    }
    setTransfersStore((previous) =>
      previous[id]?.attemptId === attemptId
        ? {
            ...previous,
            [id]: {
              ...previous[id],
              status: result.ok ? 'done' : intent || 'error',
              errorCode: result.ok ? undefined : result.errorCode,
              // A stopped row keeps the raw message: for `stagingLeft` it is the path.
              errorMessage: intent && !result.ok ? result.error : message,
            },
          }
        : previous,
    );
    return !!intent;
  };

  return { startTransfer, beginAttempt, requeueAttempt, settleTransferResult };
}
