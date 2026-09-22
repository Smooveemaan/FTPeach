import {
  checkedResponse,
  commandFailure,
  isCommandRecord,
  isStringArray,
} from '../ipcContracts.ts';
import type { CommandResult, InvokeFn } from '../ipcContracts.ts';
import { reportAsyncFailure } from '../../shared/asyncFailure.ts';

export interface AppSettings {
  recentSiteIds?: string[];
  saveSessionOnExit?: boolean;
  autoReconnectTabs?: boolean;
  [key: string]: unknown;
}

/**
 * What `settings_set` resolves to. On success the backend echoes the whole
 * settings map back, which is why the index signature is here and why `ok` is
 * optional: a successful response carries no `ok` at all. A failed one is a
 * plain {@link CommandResult}, so `ok: false` and `error` are the only fields
 * that can be relied on then.
 */
export interface SettingsSetResult extends AppSettings {
  ok?: boolean | undefined;
  error?: string | undefined;
  proxyPasswordSet?: boolean | undefined;
}

/** Settings that protect the user; `settings_set` refuses to relax them. */
const SECURITY_SETTINGS = new Set(['showSecurityConfirmations', 'vaultAutoLockMinutes']);

function isAppSettings(value: unknown): value is AppSettings {
  if (!isCommandRecord(value)) return false;
  // Only the three declared fields are checked. The rest of the map is
  // deliberately `unknown`: `normalizeSettings` in useSettings.ts already
  // reads every one of them defensively, and duplicating that list here would
  // be a second place to update for every new setting.
  return (
    (value.recentSiteIds === undefined || isStringArray(value.recentSiteIds)) &&
    (value.saveSessionOnExit === undefined || typeof value.saveSessionOnExit === 'boolean') &&
    (value.autoReconnectTabs === undefined || typeof value.autoReconnectTabs === 'boolean')
  );
}

function isSettingsSetResult(value: unknown): value is SettingsSetResult {
  return (
    isAppSettings(value) &&
    (value.ok === undefined || typeof value.ok === 'boolean') &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.proxyPasswordSet === undefined || typeof value.proxyPasswordSet === 'boolean')
  );
}

export function createSettingsApi(invoke: InvokeFn) {
  return {
    get: (): Promise<AppSettings> =>
      // A settings map that cannot be read is not a failure the caller can act
      // on — the defaults in `useSettings` cover it — so this normalizes to an
      // empty map rather than widening the type with a CommandResult.
      checkedResponse(
        'settings_get',
        invoke('settings_get'),
        isAppSettings,
        (): AppSettings => ({}),
      ).then((settings) => {
        if (isStringArray(settings.storageWarnings) && settings.storageWarnings.length > 0)
          reportAsyncFailure(settings.storageWarnings.join('\n'));
        return settings;
      }),
    set: async (patch: Record<string, unknown>): Promise<SettingsSetResult> => {
      // The backend confirms relaxing protection itself, in its own window,
      // so these settings travel through their own command first. If that is
      // cancelled, nothing else from the patch is saved either.
      const security = Object.fromEntries(
        Object.entries(patch).filter(([key]) => SECURITY_SETTINGS.has(key)),
      );
      if (Object.keys(security).length > 0) {
        const applied = await checkedResponse(
          'settings_set_security',
          invoke('settings_set_security', { patch: security }),
          isSettingsSetResult,
          (raw): SettingsSetResult => ({ ...commandFailure('settings_set_security', raw) }),
        );
        if (applied.ok === false) return applied;
      }
      const rest = Object.fromEntries(
        Object.entries(patch).filter(([key]) => !SECURITY_SETTINGS.has(key)),
      );
      return checkedResponse(
        'settings_set',
        invoke('settings_set', { patch: rest }),
        isSettingsSetResult,
        (raw): SettingsSetResult => ({ ...commandFailure('settings_set', raw) }),
      );
    },
    revealProxyPassword: (): Promise<string | null | CommandResult> =>
      checkedResponse(
        'settings_reveal_proxy_password',
        invoke('settings_reveal_proxy_password'),
        (value): value is string | null => value === null || typeof value === 'string',
        (raw) => commandFailure('settings_reveal_proxy_password', raw),
      ),
  };
}
