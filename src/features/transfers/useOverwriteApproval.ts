import { useRef } from 'react';
import { api } from '../../platform/api/index.ts';

export interface TransferTarget {
  kind: 'local' | 'remote';
  path: string;
  connectionId?: string;
}
export interface TransferOverwriteOptions {
  overwriteAction?: 'ask' | 'skip' | 'overwrite';
  confirmOverwrite?: (path: string) => Promise<boolean>;
}
export type OverwriteApproval = (target: TransferTarget) => Promise<boolean | null>;

/** Serializes overwrite prompts while each operation retains its own decision. */
export function useOverwriteApproval({
  overwriteAction = 'ask',
  confirmOverwrite,
}: TransferOverwriteOptions): OverwriteApproval {
  const confirmations = useRef<Promise<unknown>>(Promise.resolve());
  type Listing = Awaited<ReturnType<typeof api.session.list>>;
  const pendingListings = useRef(new Map<string, Promise<Listing>>());
  const approveTarget: OverwriteApproval = async (target) => {
    if (overwriteAction === 'overwrite') return true;
    const separator = target.kind === 'local' ? /[\\/]/ : /\//;
    const parts = target.path.split(separator);
    const name = parts.pop()!;
    const parent = parts.join(target.kind === 'local' ? '\\' : '/') || '/';
    const key = JSON.stringify([target.kind, target.connectionId ?? null, parent]);
    let pending = pendingListings.current.get(key);
    if (!pending) {
      // Share only an in-flight lookup. A later operation must see fresh
      // directory contents, including files written by this transfer batch.
      pending = (
        target.kind === 'local'
          ? api.fsLocal.list(parent)
          : api.session.list(target.connectionId!, parent)
      ).finally(() => pendingListings.current.delete(key));
      pendingListings.current.set(key, pending);
    }
    const listing = await pending;
    if (!listing.ok) throw new Error(parent + ': ' + (listing.error || 'Cannot check destination'));
    const exists = listing.entries.some((entry) =>
      target.kind === 'local'
        ? entry.name.toLowerCase() === name.toLowerCase()
        : entry.name === name,
    );
    // A free name needs no permission: every backend commits without
    // replacing, so a file that appears there meanwhile is refused, not lost.
    if (!exists) return false;
    if (overwriteAction === 'skip' || !confirmOverwrite) return null;
    const decision = confirmations.current.then(() => confirmOverwrite(target.path));
    // Keep later confirmations running; the awaited decision below propagates
    // this failure to the operation that requested it.
    confirmations.current = decision.catch(() => {});
    return (await decision) ? true : null;
  };
  return approveTarget;
}
