import { useRef } from 'react';
import { localSeparator } from '../../platform/os.ts';
import { api } from '../../platform/api/index.ts';
import { useTranslation } from 'react-i18next';
import { isolate } from '../../shared/bidi.ts';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import { dropDestinationPath, joinLocalPath, joinRemotePath } from '../../shared/paths.ts';
import type {
  FileEntry,
  NameConflictAction,
  NameConflictDecision,
} from '../../shared/paneContracts.ts';
import { availableCopyName, isTransferNameConflict } from './nameConflict.ts';
import type { FileEntryLike } from './nameConflict.ts';

export interface TransferTarget {
  kind: 'local' | 'remote';
  path: string;
  connectionId?: string | null;
  merge?: boolean;
}
export interface TransferOverwriteOptions {
  overwriteAction?: 'ask' | 'skip' | 'overwrite';
  confirmOverwrite?: (path: string, remaining: number) => Promise<NameConflictDecision>;
  confirmMerge?: (path: string) => Promise<boolean>;
}
export interface TargetApproval {
  path: string;
  overwrite: boolean;
}
export type OverwriteApproval = (target: TransferTarget) => Promise<TargetApproval | null>;
export interface BatchTarget extends TransferTarget {
  entries: FileEntry[];
}
export interface BatchApproval {
  names: string[];
  overwrites: string[];
  copies: Record<string, string>;
}
interface OverwriteApprovalModel {
  approveTarget: OverwriteApproval;
  approveBatch: (
    target: BatchTarget,
    targetFolder: string | null | undefined,
    names: string[],
    sources: Pick<FileEntry, 'name' | 'isDirectory'>[],
  ) => Promise<BatchApproval>;
}

/** Serializes overwrite prompts while each operation retains its own decision. */
export function useOverwriteApproval(
  { overwriteAction = 'ask', confirmOverwrite, confirmMerge }: TransferOverwriteOptions,
  reportError: (message: string) => unknown,
): OverwriteApprovalModel {
  const { t } = useTranslation();
  const confirmations = useRef<Promise<unknown>>(Promise.resolve());
  type Listing = Awaited<ReturnType<typeof api.session.list>>;
  const pendingListings = useRef(new Map<string, Promise<Listing>>());
  const list = (target: TransferTarget) => {
    if (target.kind === 'remote' && !target.connectionId)
      throw new Error('Remote pane has no active connection');
    const key = JSON.stringify([target.kind, target.connectionId ?? null, target.path]);
    let pending = pendingListings.current.get(key);
    if (!pending) {
      // Share only an in-flight lookup. A later operation must see fresh
      // directory contents, including files written by this transfer batch.
      pending = (
        target.kind === 'local'
          ? api.fsLocal.list(target.path)
          : api.session.list(target.connectionId!, target.path)
      ).finally(() => pendingListings.current.delete(key));
      pendingListings.current.set(key, pending);
    }
    return pending;
  };
  const confirm = <T>(ask: () => Promise<T>) => {
    const decision = confirmations.current.then(ask);
    // One failed question must not block the questions queued behind it.
    confirmations.current = decision.catch(() => {});
    return decision;
  };
  const matches = (kind: TransferTarget['kind'], left: string, right: string) =>
    kind === 'local' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const approveTarget: OverwriteApproval = async (target) => {
    if (overwriteAction === 'overwrite') return { path: target.path, overwrite: true };
    const separator = target.kind === 'local' ? localSeparator() : '/';
    const parts = target.path.split(separator === '\\' ? /[\\/]/ : /\//);
    const name = parts.pop()!;
    let parent = parts.join(separator) || '/';
    if (separator === '\\' && /^[a-z]:$/i.test(parent)) parent += separator;
    const listing = await list({ ...target, path: parent });
    if (!listing.ok)
      throw new Error(friendlyError(commandResultError(listing)) || 'Cannot check destination');
    const exists = listing.entries.find((entry) => matches(target.kind, entry.name, name));
    if (target.merge && exists && !exists.isDirectory)
      throw new Error(t('errors.typeConflict', { name: isolate(name) }));
    // A free name needs no permission: every backend commits without
    // replacing, so a file that appears there meanwhile is refused, not lost.
    if (!exists) return { path: target.path, overwrite: false };
    const ask = target.merge ? confirmMerge : undefined;
    if (target.merge) {
      if (overwriteAction === 'skip' || !ask) return null;
      return (await confirm(() => ask(target.path)))
        ? { path: target.path, overwrite: true }
        : null;
    }
    if (overwriteAction === 'skip' || !confirmOverwrite) return null;
    const decision = await confirm(() => confirmOverwrite(target.path, 0));
    if (decision.action === 'skip') return null;
    if (decision.action === 'overwrite') return { path: target.path, overwrite: true };
    const copyName = availableCopyName(name, listing.entries, target.kind);
    const join = target.kind === 'local' ? joinLocalPath : joinRemotePath;
    return { path: join(parent, copyName), overwrite: false };
  };
  /** Batch approval keeps folder merges and type collisions distinct from file replacement. */
  const approveBatch = async (
    target: BatchTarget,
    targetFolder: string | null | undefined,
    names: string[],
    sources: Pick<FileEntry, 'name' | 'isDirectory'>[],
  ) => {
    let entries = target.entries;
    if (targetFolder) {
      const listing = await list({
        ...target,
        path: dropDestinationPath(target.kind, target.path, targetFolder),
      });
      if (!listing.ok)
        throw new Error(friendlyError(commandResultError(listing)) || 'Cannot list destination');
      entries = listing.entries;
    }
    const sourceOf = (name: string) => sources.find((entry) => entry.name === name);
    const destinationOf = (name: string) =>
      entries.find((entry) => matches(target.kind, entry.name, name));
    const taken = names.filter((name) => {
      const source = sourceOf(name);
      const destination = destinationOf(name);
      return source && destination && source.isDirectory !== destination.isDirectory;
    });
    if (taken.length) {
      reportError(t('errors.typeConflict', { name: taken.map(isolate).join(', ') }));
      names = names.filter((name) => !taken.includes(name));
    }
    const conflicts = names.filter((name) =>
      isTransferNameConflict(sourceOf(name), destinationOf(name)),
    );
    if (!conflicts.length) return { names, overwrites: [], copies: {} };
    if (overwriteAction === 'overwrite') return { names, overwrites: conflicts, copies: {} };
    if (overwriteAction === 'skip')
      return {
        names: names.filter((name) => !conflicts.includes(name)),
        overwrites: [],
        copies: {},
      };
    const approved: BatchApproval = {
      names: names.filter((name) => !conflicts.includes(name)),
      overwrites: [],
      copies: {},
    };
    const occupied: FileEntryLike[] = [...entries];
    let applyToAll: NameConflictAction | undefined;
    for (const [index, name] of conflicts.entries()) {
      const decision = applyToAll
        ? { action: applyToAll }
        : confirmOverwrite
          ? await confirm(() => confirmOverwrite(name, conflicts.length - index - 1))
          : { action: 'skip' as const };
      if (decision.applyToAll) applyToAll = decision.action;
      if (decision.action === 'skip') continue;
      approved.names.push(name);
      if (decision.action === 'overwrite') approved.overwrites.push(name);
      else {
        const copyName = availableCopyName(name, occupied, target.kind);
        approved.copies[name] = copyName;
        occupied.push({ name: copyName });
      }
    }
    approved.names = names.filter((name) => approved.names.includes(name));
    return approved;
  };
  return { approveTarget, approveBatch };
}
