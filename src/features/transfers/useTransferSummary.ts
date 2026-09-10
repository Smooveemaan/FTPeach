import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { TransferState } from './transferStore.ts';
import {
  canPauseTransfer,
  canRetryTransfer,
  getTransfersSnapshot,
  subscribeTransfers,
} from './transferStore.ts';

export interface TransferSummary {
  transfersEmpty: boolean;
  hasCompletedTransfers: boolean;
  hasActiveTransfers: boolean;
  activeTransfersCount: number;
  hasPausableTransfers: boolean;
  hasPausedTransfers: boolean;
  canResumeAllTransfers: boolean;
  hasRetryableTransfers: boolean;
}

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

const shallowEqual = (left: TransferSummary, right: TransferSummary) => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key as keyof TransferSummary] === right[key as keyof TransferSummary])
  );
};

export function useTransferSummary(): TransferSummary {
  const cacheRef = useRef<{ raw: TransferState; summary: TransferSummary } | null>(null);
  const getSnapshot = useCallback(() => {
    const raw = getTransfersSnapshot();
    if (cacheRef.current?.raw === raw) return cacheRef.current.summary;
    const next = computeTransferSummary(raw);
    const previous = cacheRef.current?.summary;
    const summary = previous && shallowEqual(previous, next) ? previous : next;
    cacheRef.current = { raw, summary };
    return summary;
  }, []);
  return useSyncExternalStore(subscribeTransfers, getSnapshot);
}
