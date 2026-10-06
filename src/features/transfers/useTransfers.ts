import type { TransferLifecycleModel } from './useTransferLifecycle.ts';
import type { TransferSummary } from './useTransferSummary.ts';
import { useTransferLifecycle } from './useTransferLifecycle.ts';
import { useTransferSummary } from './useTransferSummary.ts';
import { createTransferRouting } from './createTransferRouting.ts';
import type { TransferRoutingModel } from './createTransferRouting.ts';
import { useOverwriteApproval } from './useOverwriteApproval.ts';
import type { TransferOverwriteOptions } from './useOverwriteApproval.ts';
import type { BatchTarget } from './useOverwriteApproval.ts';
import type { FileEntry } from '../../shared/paneContracts.ts';
import { api } from '../../platform/api/index.ts';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import { dropDestinationPath, joinLocalPath, joinRemotePath } from '../../shared/paths.ts';
import { emptyBatch, failedBatch, summarizeBatch } from './transferBatchResult.ts';
import type { TransferBatchResult, TransferItemResult } from './transferBatchResult.ts';

type CopyEntriesOptions = Omit<
  Parameters<TransferRoutingModel['copyEntries']>[0],
  'overwriteApproved'
>;

export interface TransfersModel
  extends
    Omit<TransferLifecycleModel, 'runLocalCopy' | 'runRecursive' | 'runRemoteCopy'>,
    TransferSummary {
  copyEntries: (options: CopyEntriesOptions) => Promise<TransferBatchResult>;
  handleOsDropFiles: (
    target: Parameters<TransferRoutingModel['handleOsDropFiles']>[0],
    files: Parameters<TransferRoutingModel['handleOsDropFiles']>[1],
    folder?: string | null,
    refresh?: () => unknown,
  ) => Promise<TransferBatchResult>;
  /** Moves entries into a folder of the same pane using native rename. */
  moveWithinPane: (
    pane: BatchTarget,
    names: string[],
    folder: string,
    refresh: () => unknown,
  ) => Promise<TransferBatchResult>;
}

/** Composes overwrite policy, job lifecycle, pane routing and queue summary. */
export function useTransfers({
  setErrorMessage,
  withdrawErrorMessage,
  overwriteAction = 'ask',
  confirmOverwrite,
  confirmOverwriteBatch,
  confirmMerge,
}: TransferOverwriteOptions & {
  setErrorMessage: (message?: string) => unknown;
  /** Takes back a message this transfer showed, once it has gone through. */
  withdrawErrorMessage?: (message: string) => void;
}): TransfersModel {
  const { approveTarget, approveBatch } = useOverwriteApproval(
    {
      overwriteAction,
      ...(confirmOverwrite ? { confirmOverwrite } : {}),
      ...(confirmMerge ? { confirmMerge } : {}),
      ...(confirmOverwriteBatch ? { confirmOverwriteBatch } : {}),
    },
    setErrorMessage,
  );
  const lifecycle = useTransferLifecycle(setErrorMessage, approveTarget, withdrawErrorMessage);
  const { runLocalCopy, runRecursive, runRemoteCopy, ...commands } = lifecycle;
  const routing = createTransferRouting(lifecycle, approveTarget, overwriteAction, setErrorMessage);
  const summary = useTransferSummary();
  const runBatch = async (
    target: BatchTarget,
    folder: string | null | undefined,
    names: string[],
    sources: Pick<FileEntry, 'name' | 'isDirectory'>[],
    execute: (names: string[], approved: boolean) => Promise<TransferBatchResult>,
    moving = false,
  ): Promise<TransferBatchResult> => {
    if (!names.length) return emptyBatch();
    try {
      const approved = await approveBatch(target, folder, names, sources);
      const result = approved.names.length
        ? await execute(approved.names, approved.overwriteApproved)
        : emptyBatch();
      const included = new Set(approved.names);
      const skipped = names
        .filter((name) => !included.has(name))
        .map((name) => ({
          name,
          outcome: 'skipped' as const,
          sourceRetained: moving,
        }));
      return {
        ...result,
        items: [...skipped, ...result.items],
        skipped: result.skipped + skipped.length,
        sourceRetained: result.sourceRetained || (moving && skipped.length > 0),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      return failedBatch(message, moving);
    }
  };
  const copyEntries: TransfersModel['copyEntries'] = (options) =>
    runBatch(
      options.targetPane,
      options.targetFolder,
      options.names,
      options.sourcePane.entries,
      (names, overwriteApproved) => routing.copyEntries({ ...options, names, overwriteApproved }),
      !!options.move,
    );
  const handleOsDropFiles: TransfersModel['handleOsDropFiles'] = (target, files, folder, refresh) =>
    runBatch(
      target,
      folder,
      files.map((file) => file.name),
      files,
      (names, approved) =>
        routing.handleOsDropFiles(
          target,
          files.filter((file) => names.includes(file.name)),
          folder,
          refresh,
          approved,
        ),
    );
  const moveWithinPane: TransfersModel['moveWithinPane'] = (pane, names, folder, refresh) =>
    runBatch(
      pane,
      folder,
      names,
      pane.entries,
      async (approvedNames, overwrite) => {
        const join = pane.kind === 'local' ? joinLocalPath : joinRemotePath;
        const target = dropDestinationPath(pane.kind, pane.path, folder);
        if (pane.kind === 'remote' && !pane.connectionId)
          throw new Error('Remote pane has no active connection');
        const items: TransferItemResult[] = [];
        for (const name of approvedNames) {
          const source = join(pane.path, name);
          const destination = join(target, name);
          const response =
            pane.kind === 'local'
              ? await api.fsLocal.rename(source, destination, overwrite)
              : await api.session.rename(pane.connectionId!, source, destination, overwrite);
          if (!response.ok)
            setErrorMessage(friendlyError(commandResultError(response)) ?? undefined);
          items.push({
            name,
            outcome: response.ok ? 'moved' : 'failed',
            sourceRetained: !response.ok,
          });
        }
        refresh();
        return summarizeBatch(items, true);
      },
      true,
    );
  return { ...commands, copyEntries, handleOsDropFiles, moveWithinPane, ...summary };
}
