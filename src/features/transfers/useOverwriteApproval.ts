import { useRef } from 'react';
import { api } from '../../platform/api/index.ts';
import type { SiteProtocol } from '../../shared/types.ts';

export interface TransferTarget {
  kind: 'local' | 'remote';
  path: string;
  connectionId?: string;
  protocol?: SiteProtocol;
}
export interface TransferOverwriteOptions {
  overwriteAction?: 'ask' | 'skip' | 'overwrite';
  confirmOverwrite?: (path: string, exists: boolean) => Promise<boolean>;
}
export type OverwriteApproval = (target: TransferTarget) => Promise<boolean | null>;

/** Serializes overwrite prompts while each operation retains its own decision. */
export function useOverwriteApproval({
  overwriteAction = 'ask',
  confirmOverwrite,
}: TransferOverwriteOptions): OverwriteApproval {
  const confirmations = useRef<Promise<unknown>>(Promise.resolve());
  const approveTarget: OverwriteApproval = async (target) => {
    if (overwriteAction === 'overwrite') return true;
    const separator = target.kind === 'local' ? /[\\/]/ : /\//;
    const parts = target.path.split(separator);
    const name = parts.pop()!;
    const parent = parts.join(target.kind === 'local' ? '\\' : '/') || '/';
    const listing =
      target.kind === 'local'
        ? await api.fsLocal.list(parent)
        : await api.session.list(target.connectionId!, parent);
    if (!listing.ok) throw new Error(parent + ': ' + (listing.error || 'Cannot check destination'));
    const exists = listing.entries.some((entry) =>
      target.kind === 'local'
        ? entry.name.toLowerCase() === name.toLowerCase()
        : entry.name === name,
    );
    if (!exists && !(target.protocol === 'ftp' || target.protocol === 'ftps')) return false;
    if (!exists && overwriteAction === 'skip') return false;
    if (!exists && !confirmOverwrite) return false;
    if (overwriteAction === 'skip' || !confirmOverwrite) return null;
    const decision = confirmations.current.then(() => confirmOverwrite(target.path, exists));
    // Keep later confirmations running; the awaited decision below propagates
    // this failure to the operation that requested it.
    confirmations.current = decision.catch(() => {});
    return (await decision) ? true : null;
  };
  return approveTarget;
}
