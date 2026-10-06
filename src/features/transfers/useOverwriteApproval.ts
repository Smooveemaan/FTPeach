import { useRef } from 'react';
import { api } from '../../platform/api/index.ts';
import { useTranslation } from 'react-i18next';
import { isolate } from '../../shared/bidi.ts';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import { dropDestinationPath } from '../../shared/paths.ts';
import type { FileEntry } from '../../shared/paneContracts.ts';
import { isTransferNameConflict } from './nameConflict.ts';

export interface TransferTarget {
  kind: 'local' | 'remote';
  path: string;
  connectionId?: string | null;
  merge?: boolean;
}
export interface TransferOverwriteOptions {
  overwriteAction?: 'ask' | 'skip' | 'overwrite';
  confirmOverwrite?: (path: string) => Promise<boolean>;
  confirmMerge?: (path: string) => Promise<boolean>;
  confirmOverwriteBatch?: (names: string[]) => Promise<boolean>;
}
export type OverwriteApproval = (target: TransferTarget) => Promise<boolean | null>;
export interface BatchTarget extends TransferTarget {
  entries: FileEntry[];
}
interface OverwriteApprovalModel {
  approveTarget: OverwriteApproval;
  approveBatch: (
    target: BatchTarget,
    targetFolder: string | null | undefined,
    names: string[],
    sources: Pick<FileEntry, 'name' | 'isDirectory'>[],
  ) => Promise<{ names: string[]; overwriteApproved: boolean }>;
}

/** Serializes overwrite prompts while each operation retains its own decision. */
export function useOverwriteApproval(
  {
    overwriteAction = 'ask',
    confirmOverwrite,
    confirmOverwriteBatch,
    confirmMerge,
  }: TransferOverwriteOptions,
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
  const confirm = (ask: () => Promise<boolean>) => {
    const decision = confirmations.current.then(ask);
    // One failed question must not block the questions queued behind it.
    confirmations.current = decision.catch(() => {});
    return decision;
  };
  const matches = (kind: TransferTarget['kind'], left: string, right: string) =>
    kind === 'local' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const approveTarget: OverwriteApproval = async (target) => {
    if (overwriteAction === 'overwrite') return true;
    const separator = target.kind === 'local' ? /[\\/]/ : /\//;
    const parts = target.path.split(separator);
    const name = parts.pop()!;
    const parent = parts.join(target.kind === 'local' ? '\\' : '/') || '/';
    const pending = list({ ...target, path: parent });
    const listing = await pending;
    if (!listing.ok) throw new Error(parent + ': ' + (listing.error || 'Cannot check destination'));
    const exists = listing.entries.find((entry) => matches(target.kind, entry.name, name));
    if (target.merge && exists && !exists.isDirectory)
      throw new Error(t('errors.typeConflict', { name: isolate(name) }));
    // A free name needs no permission: every backend commits without
    // replacing, so a file that appears there meanwhile is refused, not lost.
    if (!exists) return false;
    const ask = target.merge ? confirmMerge : confirmOverwrite;
    if (overwriteAction === 'skip' || !ask) return null;
    return (await confirm(() => ask(target.path))) ? true : null;
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
    if (!conflicts.length) return { names, overwriteApproved: false };
    if (overwriteAction === 'overwrite') return { names, overwriteApproved: true };
    if (overwriteAction === 'skip')
      return { names: names.filter((name) => !conflicts.includes(name)), overwriteApproved: false };
    const approved =
      confirmOverwriteBatch && (await confirm(() => confirmOverwriteBatch(conflicts)));
    return { names: approved ? names : [], overwriteApproved: !!approved };
  };
  return { approveTarget, approveBatch };
}
