import { useSyncExternalStore } from 'react';
import type { TransferState } from './transferStore.ts';
import {
  canPauseTransfer,
  canRetryTransfer,
  getTransferSummarySnapshot,
  subscribeTransfers,
} from './transferStore.ts';

import type { TransferSummary } from './transferStore.ts';
export type { TransferSummary } from './transferStore.ts';

export function computeTransferSummary(transfers: TransferState): TransferSummary {
  const values = Object.values(transfers);
  const hasPausableTransfers = values.some(
    (item) => (item.status === 'progress' || item.status === 'queued') && canPauseTransfer(item),
  );
  const hasPausedTransfers = values.some((item) => item.status === 'paused');
  return {
    transfersEmpty: values.length === 0,
    hasCompletedTransfers: values.some((item) =>
      ['done', 'error', 'stopped'].includes(item.status),
    ),
    hasActiveTransfers: values.some(
      (item) =>
        item.status === 'progress' || item.status === 'queued' || item.status === 'cancelling',
    ),
    activeTransfersCount: values.filter(
      (item) =>
        item.status === 'progress' || item.status === 'queued' || item.status === 'cancelling',
    ).length,
    hasPausableTransfers,
    hasPausedTransfers,
    // Resume-all takes the shared pause button over as soon as nothing still
    // running can be paused, even while such transfers carry on: a WebDAV
    // upload beside the paused rows must not lock them out of resuming. A
    // pause still winding down holds it back, since resume-all would skip that
    // row and leave it to land paused on its own afterwards.
    canResumeAllTransfers:
      hasPausedTransfers &&
      !hasPausableTransfers &&
      !values.some((item) => item.status === 'cancelling'),
    hasRetryableTransfers: values.some(
      (item) => ['error', 'stopped'].includes(item.status) && canRetryTransfer(item),
    ),
  };
}

export function useTransferSummary(): TransferSummary {
  return useSyncExternalStore(subscribeTransfers, getTransferSummarySnapshot);
}
