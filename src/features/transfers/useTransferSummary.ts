import { useSyncExternalStore } from 'react';
import { getTransferSummarySnapshot, subscribeTransfers } from './transferStore.ts';

import type { TransferSummary } from './transferStore.ts';
export type { TransferSummary } from './transferStore.ts';

export function useTransferSummary(): TransferSummary {
  return useSyncExternalStore(subscribeTransfers, getTransferSummarySnapshot);
}
