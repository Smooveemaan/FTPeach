import { checkedResponse, commandFailure, hasCommandOutcome, isRecord } from '../ipcContracts.ts';
import type { CommandResult, InvokeFn } from '../ipcContracts.ts';
import type { ManagedSite } from '../../shared/types.ts';
import { reportAsyncFailure } from '../../shared/asyncFailure.ts';

export type SavedSite = Record<string, unknown> & {
  id?: string;
  kind?: 'site' | 'local' | 'folder';
  managerScope?: 'bookmarks' | 'localPaths';
};
export interface SiteLayoutEntry {
  id: string;
  parentId: string | null;
}
export type SiteLayout = SiteLayoutEntry[];
export type SiteMutationResult = CommandResult & { secretNotPersisted?: boolean };
export type RevealSecretResult = CommandResult & { value?: string };

function isManagedSiteArray(value: unknown): value is ManagedSite[] {
  return (
    Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === 'string')
  );
}

function isSiteMutationResult(value: unknown): value is SiteMutationResult {
  return (
    hasCommandOutcome(value) &&
    (value.secretNotPersisted === undefined || typeof value.secretNotPersisted === 'boolean')
  );
}

function isRevealSecretResult(value: unknown): value is RevealSecretResult {
  return hasCommandOutcome(value) && (value.value === undefined || typeof value.value === 'string');
}

export function createSitesApi(invoke: InvokeFn) {
  const mutation = (command: string, args?: Record<string, unknown>) =>
    checkedResponse(
      command,
      invoke(command, args),
      isSiteMutationResult,
      (raw): SiteMutationResult => commandFailure(command, raw),
    );

  return {
    list: async (): Promise<ManagedSite[]> => {
      const result = await invoke('sites_list');
      if (isRecord(result) && isManagedSiteArray(result.sites)) {
        if (
          Array.isArray(result.warnings) &&
          result.warnings.every((warning) => typeof warning === 'string') &&
          result.warnings.length > 0
        )
          reportAsyncFailure(result.warnings.join('\n'));
        return result.sites;
      }
      if (isManagedSiteArray(result)) return result;
      reportAsyncFailure(commandFailure('sites_list', result).error);
      return [];
    },
    save: (site: SavedSite) => mutation('sites_save', { site }),
    delete: (id: string) => mutation('sites_delete', { id }),
    saveFolder: (folder: SavedSite) => mutation('sites_save_folder', { folder }),
    deleteFolder: (id: string) => mutation('sites_delete_folder', { id }),
    applyLayout: (layout: SiteLayout) => mutation('sites_apply_layout', { layout }),
    // A failure to answer these is not distinguishable from a "no" for the
    // caller's purposes — both mean "do not offer the migration prompt" — so
    // they normalize to false rather than widening to a CommandResult.
    hasLegacySecret: (): Promise<boolean> =>
      checkedResponse(
        'sites_has_legacy_secret',
        invoke('sites_has_legacy_secret'),
        (value): value is boolean => typeof value === 'boolean',
        () => false,
      ),
    hasPlaintextSecret: (): Promise<boolean> =>
      checkedResponse(
        'sites_has_plaintext_secret',
        invoke('sites_has_plaintext_secret'),
        (value): value is boolean => typeof value === 'boolean',
        () => false,
      ),
    revealSecret: (id: string, field: 'password' | 'keyPassphrase') =>
      checkedResponse(
        'sites_reveal_secret',
        invoke('sites_reveal_secret', { id, field }),
        isRevealSecretResult,
        (raw): RevealSecretResult => commandFailure('sites_reveal_secret', raw),
      ),
  };
}
