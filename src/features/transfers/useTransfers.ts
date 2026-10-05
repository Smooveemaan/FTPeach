import type { TransferLifecycleModel } from './useTransferLifecycle.ts';
import type { TransferSummary } from './useTransferSummary.ts';
import { useTransferLifecycle } from './useTransferLifecycle.ts';
import { useTransferSummary } from './useTransferSummary.ts';
import { createTransferRouting } from './createTransferRouting.ts';
import type { TransferRoutingModel } from './createTransferRouting.ts';
import { useOverwriteApproval } from './useOverwriteApproval.ts';
import type { TransferOverwriteOptions } from './useOverwriteApproval.ts';

export interface TransfersModel
  extends
    Omit<TransferLifecycleModel, 'runRecursive' | 'runRemoteCopy'>,
    TransferSummary,
    TransferRoutingModel {}

/** Composes overwrite policy, job lifecycle, pane routing and queue summary. */
export function useTransfers({
  setErrorMessage,
  withdrawErrorMessage,
  overwriteAction = 'ask',
  confirmOverwrite,
}: TransferOverwriteOptions & {
  setErrorMessage: (message?: string) => unknown;
  /** Takes back a message this transfer showed, once it has gone through. */
  withdrawErrorMessage?: (message: string) => void;
}): TransfersModel {
  const approveTarget = useOverwriteApproval({
    overwriteAction,
    ...(confirmOverwrite ? { confirmOverwrite } : {}),
  });
  const lifecycle = useTransferLifecycle(setErrorMessage, approveTarget, withdrawErrorMessage);
  const { runRecursive, runRemoteCopy, ...commands } = lifecycle;
  const routing = createTransferRouting(lifecycle, approveTarget, overwriteAction, setErrorMessage);
  const summary = useTransferSummary();
  return { ...commands, ...routing, ...summary };
}
