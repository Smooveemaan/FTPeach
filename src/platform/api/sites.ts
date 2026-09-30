import { checkedResponse, commandFailure, isRecord, voidOutcome } from '../ipcContracts.ts';
import type { CommandResult, InvokeFn } from '../ipcContracts.ts';
import type { ManagedSite } from '../../shared/siteContracts.ts';
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
export type SiteMutationResult = CommandResult & { id?: string; secretNotPersisted?: boolean };
export type RevealSecretResult = CommandResult & { value?: string };

function isManagedSiteArray(value: unknown): value is ManagedSite[] {
  return (
    Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === 'string')
  );
}

/** What `sites_save` and `sites_save_folder` answer when they worked. */
interface SiteSaved {
  id: string;
  secretNotPersisted: boolean;
}

function isSiteSaved(value: unknown): value is SiteSaved {
  return (
    isRecord(value) && typeof value.id === 'string' && typeof value.secretNotPersisted === 'boolean'
  );
}

export function createSitesApi(invoke: InvokeFn) {
  const save = (command: string, args: Record<string, unknown>): Promise<SiteMutationResult> =>
    checkedResponse(command, invoke(command, args), isSiteSaved, (raw) =>
      commandFailure(command, raw),
    ).then((result) => ('ok' in result ? result : { ok: true, ...result }));

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
    save: (site: SavedSite) => save('sites_save', { site }),
    delete: (id: string): Promise<SiteMutationResult> =>
      voidOutcome(invoke, 'sites_delete', { id }),
    saveFolder: (folder: SavedSite) => save('sites_save_folder', { folder }),
    deleteFolder: (id: string): Promise<SiteMutationResult> =>
      voidOutcome(invoke, 'sites_delete_folder', { id }),
    applyLayout: (layout: SiteLayout): Promise<SiteMutationResult> =>
      voidOutcome(invoke, 'sites_apply_layout', { layout }),
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
    // No stored secret answers `null`, which is a success with nothing in it.
    revealSecret: (id: string, field: 'password' | 'keyPassphrase'): Promise<RevealSecretResult> =>
      checkedResponse(
        'sites_reveal_secret',
        invoke('sites_reveal_secret', { id, field }),
        (value): value is string | null => value === null || typeof value === 'string',
        (raw): RevealSecretResult => commandFailure('sites_reveal_secret', raw),
      ).then((value) =>
        typeof value === 'string' ? { ok: true, value } : (value ?? { ok: true }),
      ),
  };
}
