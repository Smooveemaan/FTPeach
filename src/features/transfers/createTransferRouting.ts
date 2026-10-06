import { api } from '../../platform/api/index.ts';
import type { TransferLifecycleModel, RefreshCallback } from './useTransferLifecycle.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { mapSettled, mapWithConcurrency } from '../../shared/lang.ts';
import { emptyBatch, failedBatch, summarizeBatch } from './transferBatchResult.ts';
import { beginTransferBatch } from './transferStore.ts';
import type {
  TransferBatchResult,
  TransferItemOutcome,
  TransferItemResult,
} from './transferBatchResult.ts';
import { canMoveBetween } from '../../shared/movePolicy.ts';
import { dropDestinationPath, joinLocalPath, joinRemotePath } from '../../shared/paths.ts';
import type { FileEntry, PaneKind, PaneStatus } from '../../shared/paneContracts.ts';
import type { SiteProtocol } from '../../shared/siteContracts.ts';
import type { OverwriteApproval, TransferOverwriteOptions } from './useOverwriteApproval.ts';
interface TransferPane {
  kind: PaneKind;
  status: PaneStatus;
  connectionId: string | null;
  protocol: SiteProtocol | null;
  path: string;
  entries: FileEntry[];
}
interface CopyEntriesOptions {
  sourcePane: TransferPane;
  targetPane: TransferPane;
  names: string[];
  targetFolder?: string | null;
  move?: boolean;
  refreshSource?: RefreshCallback;
  refreshTarget?: RefreshCallback;
  /** Batch approval supplied internally by useTransfers. */
  overwriteApproved?: boolean;
}
interface OsDropFile {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
}
const RENDERER_FANOUT_LIMIT = 8;
/**
 * How many transfers a selection may have in flight at once. The backend owns
 * network concurrency and queues what it cannot start, but admitting a whole
 * 10 000-file selection in one go builds that queue in the renderer first —
 * thousands of pending calls, rows and progress subscriptions, most of them for
 * work the destination may already have refused. Items are admitted as earlier
 * ones settle instead, which keeps the order and the visible queue intact.
 */
const TRANSFER_ADMISSION_LIMIT = 64;
// Paused, stopped, skipped or already queued is the user's call, not a refusal.
const outcomeOf = (
  report: { ok: boolean; skipped?: boolean; alreadyRunning?: boolean; cancelled?: boolean },
  done: 'copied' | 'moved',
): TransferItemOutcome =>
  report.ok
    ? done
    : report.skipped || report.alreadyRunning || report.cancelled
      ? 'skipped'
      : 'failed';
const MOVE_BETWEEN_ENDPOINTS =
  'Files can be moved only within this computer or within one server connection';

async function requireSuccess(result: Promise<CommandResult>, path: string) {
  const outcome = await result;
  if (!outcome.ok) throw new Error(`${path}: ${outcome.error || 'File operation failed'}`);
}

export interface TransferRoutingModel {
  copyEntries: (options: CopyEntriesOptions) => Promise<TransferBatchResult>;
  handleOsDropFiles: (
    targetPane: TransferPane,
    files: OsDropFile[],
    targetFolder?: string | null,
    refreshTarget?: RefreshCallback,
    overwriteApproved?: boolean,
  ) => Promise<TransferBatchResult>;
}

/** Routes pane copies, moves and OS drops through the transfer lifecycle. */
export function createTransferRouting(
  {
    runLocalCopy,
    runRecursive,
    runUpload,
    runDownload,
    runRemoteCopy,
  }: Pick<
    TransferLifecycleModel,
    'runLocalCopy' | 'runRecursive' | 'runUpload' | 'runDownload' | 'runRemoteCopy'
  >,
  approveTarget: OverwriteApproval,
  overwriteAction: TransferOverwriteOptions['overwriteAction'],
  setErrorMessage: (message?: string) => unknown,
): TransferRoutingModel {
  const recursiveFolder = async (
    source: TransferPane,
    target: TransferPane,
    sourcePath: string,
    targetPath: string,
    moving = false,
    refreshTarget?: RefreshCallback,
  ): Promise<TransferItemOutcome> => {
    const approved =
      overwriteAction === 'skip' &&
      !(moving && source.kind === 'remote' && target.kind === 'remote')
        ? false
        : await approveTarget({
            kind: target.kind,
            path: targetPath,
            merge: !(moving && source.kind === 'remote' && target.kind === 'remote'),
            ...(target.connectionId ? { connectionId: target.connectionId } : {}),
          });
    if (approved === null) return 'skipped';
    const report = await runRecursive(
      {
        id: crypto.randomUUID(),
        source:
          source.kind === 'local'
            ? { kind: 'local', path: sourcePath }
            : { kind: 'remote', path: sourcePath, connectionId: source.connectionId! },
        target:
          target.kind === 'local'
            ? { kind: 'local', path: targetPath }
            : { kind: 'remote', path: targetPath, connectionId: target.connectionId! },
        moving,
        overwrite: approved,
        skipExisting: overwriteAction === 'skip',
      },
      undefined,
      undefined,
      refreshTarget,
      target.protocol ?? undefined,
    );
    // A walk's `skipped` counts files inside it, so only its ending is read here.
    return outcomeOf({ ok: report.ok, cancelled: !!report.cancelled }, moving ? 'moved' : 'copied');
  };

  // A dropped path has no pane behind it, so the walk gets a stand-in built
  // from the path alone; recursiveFolder only reads the endpoint kinds and
  // their session details.
  const localEndpoint = (path: string): TransferPane => ({
    kind: 'local',
    status: 'connected',
    connectionId: null,
    protocol: null,
    path,
    entries: [],
  });

  const uploadFolderEntry = (
    connectionId: string,
    protocol: SiteProtocol,
    sourcePath: string,
    name: string,
    targetDir: string,
    refreshTarget?: RefreshCallback,
  ) =>
    recursiveFolder(
      localEndpoint(sourcePath),
      { kind: 'remote', status: 'connected', connectionId, protocol, path: targetDir, entries: [] },
      sourcePath,
      joinRemotePath(targetDir, name),
      false,
      refreshTarget,
    );

  // Pane-to-pane routing
  const copyLocalFile = async (
    source: string,
    destination: string,
    overwriteApproved: boolean,
    size?: number,
  ): Promise<TransferItemOutcome> => {
    await requireSuccess(api.fsLocal.validateCopy(source, destination), destination);
    const overwrite = overwriteApproved
      ? true
      : await approveTarget({ kind: 'local', path: destination });
    if (overwrite === null) return 'skipped';
    const res = await runLocalCopy(source, destination, overwrite, size);
    return outcomeOf(res, 'copied');
  };

  const copyLocalEntry = async (
    sourceDir: string,
    entry: FileEntry,
    targetDir: string,
    overwriteApproved = false,
  ): Promise<TransferItemOutcome> => {
    if (entry.isDirectory) throw new Error('Folders must use the recursive backend operation');
    return copyLocalFile(
      joinLocalPath(sourceDir, entry.name),
      joinLocalPath(targetDir, entry.name),
      overwriteApproved,
      entry.size,
    );
  };

  /**
   * Runs one item's work and says what it did. A refusal is the item's outcome,
   * not the batch's: the rest of the selection still has to be attempted, and
   * the user still has to be told which names did not make it.
   */
  const runItem = async (
    name: string,
    moving: boolean,
    work: () => Promise<TransferItemOutcome>,
  ): Promise<TransferItemResult> => {
    try {
      const outcome = await work();
      return { name, outcome, sourceRetained: moving && outcome !== 'moved' };
    } catch (error) {
      return {
        name,
        outcome: 'failed',
        sourceRetained: moving,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /** Runs one item per name, admitting at most `limit` at a time. */
  const runItems = async (
    names: string[],
    limit: number,
    moving: boolean,
    stopped: () => boolean,
    work: (name: string) => Promise<TransferItemOutcome>,
  ): Promise<TransferItemResult[]> => {
    const settled = await mapSettled(
      names,
      limit,
      // After "Stop all" the rest of the selection is not admitted.
      (name) => runItem(name, moving, () => (stopped() ? Promise.resolve('skipped') : work(name))),
      // Every name is attempted: one destination refusing a file says nothing
      // about the next, and the result names both anyway.
      { stopOnError: false },
    );
    return settled.map((item, index) =>
      item.status === 'fulfilled'
        ? item.value
        : { name: names[index] ?? '', outcome: 'failed' as const, sourceRetained: moving },
    );
  };

  const copyEntriesUnchecked = async (
    {
      sourcePane,
      targetPane,
      names,
      targetFolder,
      move,
      refreshSource,
      refreshTarget,
      overwriteApproved = false,
    }: CopyEntriesOptions,
    stopped: () => boolean,
  ): Promise<TransferItemResult[]> => {
    if (names.length === 0) return [];
    // Every UI entry point already offers only Copy here; this keeps a caller
    // that asks anyway from reaching the copy, let alone a delete.
    if (move && !canMoveBetween(sourcePane, targetPane)) {
      throw new Error(MOVE_BETWEEN_ENDPOINTS);
    }
    const sourceEntriesByName = new Map(sourcePane.entries.map((entry) => [entry.name, entry]));
    const targetDir = dropDestinationPath(targetPane.kind, targetPane.path, targetFolder);

    const folders = names.filter((name) => sourceEntriesByName.get(name)?.isDirectory);
    // Start the folders alongside the files rather than one after the other:
    // the backend owns network concurrency, and a folder must not hide its
    // siblings. Every group is waited for, including after one of them fails.
    if (folders.length > 0 && names.length > 1) {
      const groups = [
        ...folders.map((name) => [name]),
        names.filter((name) => !sourceEntriesByName.get(name)?.isDirectory),
      ];
      const grouped = await mapWithConcurrency(groups, TRANSFER_ADMISSION_LIMIT, (group) =>
        copyEntriesUnchecked(
          {
            sourcePane,
            targetPane,
            names: group,
            ...(targetFolder === undefined ? {} : { targetFolder }),
            ...(move === undefined ? {} : { move }),
            ...(refreshSource ? { refreshSource } : {}),
            ...(refreshTarget ? { refreshTarget } : {}),
            overwriteApproved,
          },
          stopped,
        ),
      );
      return grouped.flat();
    }
    const results: TransferItemResult[] = [];
    for (const name of folders) {
      if (stopped()) {
        results.push({ name, outcome: 'skipped', sourceRetained: !!move });
        continue;
      }
      const sourcePath =
        sourcePane.kind === 'local'
          ? joinLocalPath(sourcePane.path, name)
          : joinRemotePath(sourcePane.path, name);
      const targetPath =
        targetPane.kind === 'local'
          ? joinLocalPath(targetDir, name)
          : joinRemotePath(targetDir, name);
      results.push(
        await runItem(name, !!move, () =>
          recursiveFolder(sourcePane, targetPane, sourcePath, targetPath, move, refreshTarget),
        ),
      );
    }
    if (folders.length > 0) {
      refreshTarget?.();
      if (move) refreshSource?.();
    }
    names = names.filter((name) => !sourceEntriesByName.get(name)?.isDirectory);
    if (names.length === 0) return results;

    if (sourcePane.kind === 'local' && targetPane.kind === 'local') {
      if (move) {
        try {
          results.push(
            ...(await runItems(names, RENDERER_FANOUT_LIMIT, true, stopped, async (name) => {
              if (!sourceEntriesByName.has(name)) return 'skipped';
              const destination = joinLocalPath(targetDir, name);
              const overwrite = overwriteApproved
                ? true
                : await approveTarget({ kind: 'local', path: destination });
              if (overwrite === null) return 'skipped';
              await requireSuccess(
                api.fsLocal.rename(joinLocalPath(sourcePane.path, name), destination, overwrite),
                destination,
              );
              return 'moved';
            })),
          );
        } finally {
          refreshSource?.();
          refreshTarget?.();
        }
        return results;
      }
      results.push(
        ...(await runItems(names, RENDERER_FANOUT_LIMIT, false, stopped, async (name) => {
          const entry = sourceEntriesByName.get(name);
          if (!entry) return 'skipped';
          return copyLocalEntry(sourcePane.path, entry, targetDir, overwriteApproved);
        })),
      );
      refreshTarget?.();
      return results;
    }

    if (sourcePane.kind === 'remote' && targetPane.kind === 'remote') {
      results.push(
        ...(await runItems(names, TRANSFER_ADMISSION_LIMIT, !!move, stopped, async (name) => {
          const entry = sourceEntriesByName.get(name);
          if (!entry) return 'skipped';
          if (entry.isDirectory && move) {
            const source = joinRemotePath(sourcePane.path, name);
            const destination = joinRemotePath(targetDir, name);
            await requireSuccess(
              api.transfer.validateRemoteCopy(
                source,
                destination,
                sourcePane.connectionId!,
                targetPane.connectionId!,
                true,
              ),
              destination,
            );
          }
          if (sourcePane.connectionId === targetPane.connectionId && move) {
            const sourceFull = joinRemotePath(sourcePane.path, name);
            const destFull = joinRemotePath(targetDir, name);
            const overwrite = overwriteApproved
              ? true
              : await approveTarget({
                  kind: 'remote',
                  path: destFull,
                  connectionId: sourcePane.connectionId!,
                });
            if (overwrite === null) return 'skipped';
            // Native rename lets the server enforce directory identity and
            // aliases without a recursive copy followed by destructive delete.
            await requireSuccess(
              api.session.rename(sourcePane.connectionId!, sourceFull, destFull, overwrite),
              sourceFull,
            );
            return 'moved';
          }
          const copied = await runRemoteCopy(
            sourcePane.connectionId!,
            joinRemotePath(sourcePane.path, name),
            targetPane.connectionId!,
            targetPane.protocol!,
            name,
            targetDir,
            overwriteApproved,
          );
          return outcomeOf(copied, 'copied');
        })),
      );
      refreshTarget?.();
      if (move) refreshSource?.();
      return results;
    }

    results.push(
      ...(await runItems(names, TRANSFER_ADMISSION_LIMIT, !!move, stopped, async (name) => {
        const entry = sourceEntriesByName.get(name);
        if (!entry) return 'skipped';
        const report =
          targetPane.kind === 'remote'
            ? await runUpload(
                targetPane.connectionId!,
                targetPane.protocol!,
                joinLocalPath(sourcePane.path, name),
                name,
                targetDir,
                entry.size,
                overwriteApproved,
              )
            : await runDownload(
                sourcePane.connectionId!,
                sourcePane.protocol!,
                joinRemotePath(sourcePane.path, name),
                name,
                targetDir,
                true,
                overwriteApproved,
              );
        return outcomeOf(report, 'copied');
      })),
    );
    refreshTarget?.();
    return results;
  };

  // Files dropped from the operating system
  const handleOsDropFilesUnchecked = async (
    stopped: () => boolean,
    targetPane: TransferPane,
    files: OsDropFile[],
    targetFolder?: string | null,
    refreshTarget?: RefreshCallback,
    overwriteApproved = false,
  ): Promise<TransferItemResult[]> => {
    const targetDir = dropDestinationPath(targetPane.kind, targetPane.path, targetFolder);
    const names = files.map((file) => file.name);
    const fileByName = new Map(files.map((file) => [file.name, file]));
    // A local pane takes an OS drop the same way it takes a pane-to-pane copy:
    // the shell hands us paths that are already on disk, so files are copied
    // straight across and folders go through the recursive walk. Nothing here
    // needs a session, which is why this works with no server connected.
    if (targetPane.kind === 'local') {
      const results = await runItems(names, RENDERER_FANOUT_LIMIT, false, stopped, async (name) => {
        const file = fileByName.get(name)!;
        const destination = joinLocalPath(targetDir, file.name);
        return file.isDirectory
          ? recursiveFolder(
              localEndpoint(file.path),
              localEndpoint(targetDir),
              file.path,
              destination,
              false,
              refreshTarget,
            )
          : copyLocalFile(file.path, destination, overwriteApproved, file.size);
      });
      refreshTarget?.();
      return results;
    }
    const results = await runItems(
      names,
      TRANSFER_ADMISSION_LIMIT,
      false,
      stopped,
      async (name) => {
        const file = fileByName.get(name)!;
        if (file.isDirectory) {
          return uploadFolderEntry(
            targetPane.connectionId!,
            targetPane.protocol!,
            file.path,
            file.name,
            targetDir,
            refreshTarget,
          );
        }
        const report = await runUpload(
          targetPane.connectionId!,
          targetPane.protocol!,
          file.path,
          file.name,
          targetDir,
          file.size,
          overwriteApproved,
        );
        return outcomeOf(report, 'copied');
      },
    );
    refreshTarget?.();
    return results;
  };

  /**
   * Turns a batch into one answer: what each item did, and the one message the
   * user needs about it. An error thrown before any item ran — a Move the
   * policy refuses — is the batch's own failure and is reported as such.
   */
  const reportOperation = async (
    operation: (stopped: () => boolean) => Promise<TransferItemResult[]>,
    moving = false,
  ): Promise<TransferBatchResult> => {
    const batch = beginTransferBatch();
    let result;
    try {
      result = summarizeBatch(await operation(batch.stopped), moving);
    } catch (error) {
      result = failedBatch(error instanceof Error ? error.message : String(error), moving);
    } finally {
      batch.end();
    }
    if (result.message !== undefined) setErrorMessage(result.message);
    return result;
  };
  const copyEntries = (options: CopyEntriesOptions) =>
    options.names.length === 0
      ? Promise.resolve(emptyBatch())
      : reportOperation((stopped) => copyEntriesUnchecked(options, stopped), !!options.move);
  const handleOsDropFiles: TransferRoutingModel['handleOsDropFiles'] = (...args) =>
    reportOperation((stopped) => handleOsDropFilesUnchecked(stopped, ...args));

  return { copyEntries, handleOsDropFiles };
}
