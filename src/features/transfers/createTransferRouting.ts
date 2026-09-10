import { api } from '../../platform/api/index.ts';
import type { TransferLifecycleModel, RefreshCallback } from './useTransferLifecycle.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { mapWithConcurrency } from '../../shared/lang.ts';
import { joinLocalPath, joinRemotePath } from '../../shared/paths.ts';
import type { FileEntry, PaneKind, PaneStatus, SiteProtocol } from '../../shared/types.ts';
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
  /**
   * The caller already asked about every name that collides at the destination
   * (see usePanes' confirmOverwriteIfNeeded) and the user said yes. Without
   * this the per-destination approval below asks a second time about the very
   * same file, one dialog behind the other.
   */
  overwriteApproved?: boolean;
}
interface OsDropFile {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
}
const RENDERER_FANOUT_LIMIT = 8;

async function requireSuccess(result: Promise<CommandResult>, path: string) {
  const outcome = await result;
  if (!outcome.ok) throw new Error(`${path}: ${outcome.error || 'File operation failed'}`);
}

export interface TransferRoutingModel {
  copyEntries: (options: CopyEntriesOptions) => Promise<void>;
  handleOsDropFiles: (
    targetPane: TransferPane,
    files: OsDropFile[],
    targetFolder?: string | null,
    refreshTarget?: RefreshCallback,
    overwriteApproved?: boolean,
  ) => Promise<void>;
}

/** Routes pane copies, moves and OS drops through the transfer lifecycle. */
export function createTransferRouting(
  {
    runRecursive,
    runUpload,
    runDownload,
    runRemoteCopy,
  }: Pick<TransferLifecycleModel, 'runRecursive' | 'runUpload' | 'runDownload' | 'runRemoteCopy'>,
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
    overwriteApproved = false,
    refreshTarget?: RefreshCallback,
  ) => {
    const approved = overwriteApproved
      ? true
      : overwriteAction === 'skip' &&
          !(moving && source.kind === 'remote' && target.kind === 'remote')
        ? false
        : await approveTarget({
            kind: target.kind,
            path: targetPath,
            ...(target.connectionId ? { connectionId: target.connectionId } : {}),
          });
    if (approved === null) return false;
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
    );
    return report.ok;
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
    overwriteApproved = false,
    refreshTarget?: RefreshCallback,
  ) =>
    recursiveFolder(
      localEndpoint(sourcePath),
      { kind: 'remote', status: 'connected', connectionId, protocol, path: targetDir, entries: [] },
      sourcePath,
      joinRemotePath(targetDir, name),
      false,
      overwriteApproved,
      refreshTarget,
    );

  // Pane-to-pane routing
  const copyLocalFile = async (source: string, destination: string, overwriteApproved: boolean) => {
    await requireSuccess(api.fsLocal.validateCopy(source, destination), destination);
    const overwrite = overwriteApproved
      ? true
      : await approveTarget({ kind: 'local', path: destination });
    if (overwrite === null) return false;
    const res = await api.fsLocal.copyFile(source, destination, overwrite);
    if (!res.ok) throw new Error(`${source}: ${res.error || 'Copy failed'}`);
    return true;
  };

  const copyLocalEntry = async (
    sourceDir: string,
    entry: FileEntry,
    targetDir: string,
    overwriteApproved = false,
  ) => {
    if (entry.isDirectory) throw new Error('Folders must use the recursive backend operation');
    return copyLocalFile(
      joinLocalPath(sourceDir, entry.name),
      joinLocalPath(targetDir, entry.name),
      overwriteApproved,
    );
  };

  const copyEntriesUnchecked = async ({
    sourcePane,
    targetPane,
    names,
    targetFolder,
    move,
    refreshSource,
    refreshTarget,
    overwriteApproved = false,
  }: CopyEntriesOptions) => {
    if (names.length === 0) return;
    const sourceEntriesByName = new Map(sourcePane.entries.map((entry) => [entry.name, entry]));
    const targetDir = targetFolder
      ? targetPane.kind === 'local'
        ? joinLocalPath(targetPane.path, targetFolder)
        : joinRemotePath(targetPane.path, targetFolder)
      : targetPane.path;

    const folders = names.filter((name) => sourceEntriesByName.get(name)?.isDirectory);
    for (const name of folders) {
      const sourcePath =
        sourcePane.kind === 'local'
          ? joinLocalPath(sourcePane.path, name)
          : joinRemotePath(sourcePane.path, name);
      const targetPath =
        targetPane.kind === 'local'
          ? joinLocalPath(targetDir, name)
          : joinRemotePath(targetDir, name);
      await recursiveFolder(
        sourcePane,
        targetPane,
        sourcePath,
        targetPath,
        move,
        overwriteApproved,
        refreshTarget,
      );
    }
    if (folders.length > 0) {
      refreshTarget?.();
      if (move) refreshSource?.();
    }
    names = names.filter((name) => !sourceEntriesByName.get(name)?.isDirectory);
    if (names.length === 0) return;

    if (sourcePane.kind === 'local' && targetPane.kind === 'local') {
      const results = await mapWithConcurrency(names, RENDERER_FANOUT_LIMIT, async (name) => {
        const entry = sourceEntriesByName.get(name);
        if (!entry) return { entry, ok: false };
        return {
          entry,
          ok: await copyLocalEntry(sourcePane.path, entry, targetDir, overwriteApproved),
        };
      });
      refreshTarget?.();
      if (move) {
        const moved = results.filter((r) => r.ok && r.entry);
        if (moved.length) {
          await mapWithConcurrency(moved, RENDERER_FANOUT_LIMIT, (r) =>
            api.fsLocal.delete(joinLocalPath(sourcePane.path, r.entry!.name)),
          );
          refreshSource?.();
        }
      }
      return;
    }

    if (sourcePane.kind === 'remote' && targetPane.kind === 'remote') {
      const results = await mapWithConcurrency(names, RENDERER_FANOUT_LIMIT, async (name) => {
        const entry = sourceEntriesByName.get(name);
        if (!entry) return { entry, ok: false };
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
        if (sourcePane.connectionId === targetPane.connectionId) {
          const sourceFull = joinRemotePath(sourcePane.path, name);
          const destFull = joinRemotePath(targetDir, name);
          if (move) {
            const overwrite = overwriteApproved
              ? true
              : await approveTarget({
                  kind: 'remote',
                  path: destFull,
                  connectionId: sourcePane.connectionId!,
                });
            if (overwrite === null) return { entry, ok: false };
            // Native rename lets the server enforce directory identity and
            // aliases without a recursive copy followed by destructive delete.
            await requireSuccess(
              api.session.rename(sourcePane.connectionId!, sourceFull, destFull, overwrite),
              sourceFull,
            );
            return { entry, ok: true, renamed: true };
          }
        }
        const ok = (
          await runRemoteCopy(
            sourcePane.connectionId!,
            joinRemotePath(sourcePane.path, name),
            targetPane.connectionId!,
            targetPane.protocol!,
            name,
            targetDir,
            overwriteApproved,
          )
        ).ok;
        return { entry, ok };
      });
      refreshTarget?.();
      if (move) {
        const moved = results.filter((r) => r.ok && r.entry && !('renamed' in r && r.renamed));
        if (moved.length) {
          await mapWithConcurrency(moved, RENDERER_FANOUT_LIMIT, (r) =>
            api.session.delete(
              sourcePane.connectionId!,
              joinRemotePath(sourcePane.path, r.entry!.name),
              r.entry!.isDirectory,
            ),
          );
          refreshSource?.();
        }
        if (results.some((r) => 'renamed' in r && r.renamed)) refreshSource?.();
      }
      return;
    }

    const results = await mapWithConcurrency(names, RENDERER_FANOUT_LIMIT, async (name) => {
      const entry = sourceEntriesByName.get(name);
      if (!entry) return { entry, ok: false };
      let ok;
      if (targetPane.kind === 'remote') {
        ok = (
          await runUpload(
            targetPane.connectionId!,
            targetPane.protocol!,
            joinLocalPath(sourcePane.path, name),
            name,
            targetDir,
            entry.size,
            overwriteApproved,
          )
        ).ok;
      } else {
        ok = (
          await runDownload(
            sourcePane.connectionId!,
            sourcePane.protocol!,
            joinRemotePath(sourcePane.path, name),
            name,
            targetDir,
            true,
            overwriteApproved,
          )
        ).ok;
      }
      return { entry, ok };
    });
    refreshTarget?.();
    if (!move) return;
    const moved = results.filter((r) => r.ok && r.entry);
    if (moved.length === 0) return;
    if (sourcePane.kind === 'local') {
      await mapWithConcurrency(moved, RENDERER_FANOUT_LIMIT, (r) =>
        api.fsLocal.delete(joinLocalPath(sourcePane.path, r.entry!.name)),
      );
    } else {
      await mapWithConcurrency(moved, RENDERER_FANOUT_LIMIT, (r) =>
        api.session.delete(
          sourcePane.connectionId!,
          joinRemotePath(sourcePane.path, r.entry!.name),
          r.entry!.isDirectory,
        ),
      );
    }
    refreshSource?.();
  };

  // Files dropped from the operating system
  const handleOsDropFilesUnchecked = async (
    targetPane: TransferPane,
    files: OsDropFile[],
    targetFolder?: string | null,
    refreshTarget?: RefreshCallback,
    overwriteApproved = false,
  ) => {
    // A local pane takes an OS drop the same way it takes a pane-to-pane copy:
    // the shell hands us paths that are already on disk, so files are copied
    // straight across and folders go through the recursive walk. Nothing here
    // needs a session, which is why this works with no server connected.
    if (targetPane.kind === 'local') {
      const targetDir = targetFolder
        ? joinLocalPath(targetPane.path, targetFolder)
        : targetPane.path;
      await mapWithConcurrency(files, RENDERER_FANOUT_LIMIT, async (file) => {
        const destination = joinLocalPath(targetDir, file.name);
        if (file.isDirectory) {
          await recursiveFolder(
            localEndpoint(file.path),
            localEndpoint(targetDir),
            file.path,
            destination,
            false,
            overwriteApproved,
            refreshTarget,
          );
        } else {
          await copyLocalFile(file.path, destination, overwriteApproved);
        }
      });
      refreshTarget?.();
      return;
    }
    const targetDir = targetFolder
      ? joinRemotePath(targetPane.path, targetFolder)
      : targetPane.path;
    await mapWithConcurrency(files, RENDERER_FANOUT_LIMIT, async (file) => {
      if (file.isDirectory) {
        await uploadFolderEntry(
          targetPane.connectionId!,
          targetPane.protocol!,
          file.path,
          file.name,
          targetDir,
          overwriteApproved,
          refreshTarget,
        );
      } else {
        await runUpload(
          targetPane.connectionId!,
          targetPane.protocol!,
          file.path,
          file.name,
          targetDir,
          file.size,
          overwriteApproved,
        );
      }
    });
    refreshTarget?.();
  };

  const reportOperation = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const copyEntries = (options: CopyEntriesOptions) =>
    reportOperation(() => copyEntriesUnchecked(options));
  const handleOsDropFiles = (...args: Parameters<typeof handleOsDropFilesUnchecked>) =>
    reportOperation(() => handleOsDropFilesUnchecked(...args));

  return { copyEntries, handleOsDropFiles };
}
