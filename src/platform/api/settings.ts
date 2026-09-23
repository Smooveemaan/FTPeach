import {
  checkedResponse,
  commandFailure,
  isCommandErrorCode,
  isCommandRecord,
  isStringArray,
  normalizeCommandError,
} from '../ipcContracts.ts';
import type { CommandErrorCode, CommandResult, InvokeFn } from '../ipcContracts.ts';
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
 * plain {@link CommandResult}, so `ok: false`, `error` and `errorCode` are the
 * only fields that can be relied on then.
 */
export interface SettingsSetResult extends AppSettings {
  ok?: boolean | undefined;
  error?: string | undefined;
  errorCode?: CommandErrorCode | undefined;
  proxyPasswordSet?: boolean | undefined;
}

/** What a settings export or import covers: `app_export_settings` / `app_import_settings`. */
export interface SettingsTransferOptions {
  includeSettings: boolean;
  includeBookmarks: boolean;
  includeLocalPaths: boolean;
}
export type ExportSettingsResult = CommandResult & { canceled?: boolean };
export type ImportSettingsResult = CommandResult & {
  canceled?: boolean;
  settings?: AppSettings;
  sitesAdded?: number;
  sitesSkipped?: number;
  issues?: string[];
};

/**
 * Settings that protect the user, and the proxy's address with its password:
 * `settings_set` refuses to relax the first or to move the saved password.
 */
const SECURITY_SETTINGS = new Set([
  'showSecurityConfirmations',
  'strictHostKeyCheck',
  'vaultAutoLockMinutes',
  'proxyType',
  'proxyHost',
  'proxyPort',
  'proxyUsername',
  'proxyPassword',
  'removeProxyPassword',
]);

/**
 * The value a `settings_set_security` grant is bound to. A new proxy password
 * is named only by whether there is one, never sent here.
 */
export function securityAuthorizationTarget(patch: Record<string, unknown>): string {
  return JSON.stringify(
    typeof patch.proxyPassword === 'string'
      ? { ...patch, proxyPassword: patch.proxyPassword !== '' }
      : patch,
  );
}

/**
 * Asks the backend for a grant, which it confirms with the user in its own
 * window first. Rejects when the user declines.
 */
export type AuthorizeSensitive = (operation: string, target: string) => Promise<string>;

/** A relaxation of the protected settings the user has already confirmed. */
interface ConfirmedSecurityChange {
  patch: Record<string, unknown>;
  token: string;
}

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
    (value.errorCode === undefined || isCommandErrorCode(value.errorCode)) &&
    (value.proxyPasswordSet === undefined || typeof value.proxyPasswordSet === 'boolean')
  );
}

export function createSettingsApi(invoke: InvokeFn, authorize?: AuthorizeSensitive) {
  /**
   * The settings dialog asks for the confirmation at the switch the user
   * flips, not when they press Save, so the grant it comes back with waits
   * here until then. It is applied ahead of everything else in the patch:
   * applying another protected setting first withdraws it.
   */
  let confirmed: ConfirmedSecurityChange | null = null;

  const applySecurity = (patch: Record<string, unknown>, authorizationToken?: string) =>
    checkedResponse(
      'settings_set_security',
      invoke(
        'settings_set_security',
        authorizationToken === undefined ? { patch } : { patch, authorizationToken },
      ),
      isSettingsSetResult,
      (raw): SettingsSetResult => ({ ...commandFailure('settings_set_security', raw) }),
    );

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
    /**
     * Confirms a change that would relax protection at the moment the user
     * makes it, rather than when the dialog is saved. The grant is kept for
     * the save that follows, so the user is asked once, while they are at the
     * setting and in the language the window is showing them.
     */
    confirmSecurityChange: async (patch: Record<string, unknown>): Promise<CommandResult> => {
      confirmed = null;
      if (!authorize) return { ok: true };
      try {
        const token = await authorize('settings_set_security', securityAuthorizationTarget(patch));
        confirmed = { patch, token };
        return { ok: true };
      } catch (rawError) {
        const error = normalizeCommandError(rawError);
        return { ok: false, error: error.message, errorCode: error.code };
      }
    },
    /** Forgets a confirmation whose change was undone or never saved. */
    releaseSecurityChange: (): void => {
      confirmed = null;
    },
    set: async (patch: Record<string, unknown>): Promise<SettingsSetResult> => {
      // The backend confirms relaxing protection itself, in its own window,
      // so these settings travel through their own command first. If that is
      // cancelled, nothing else from the patch is saved either.
      const security = Object.fromEntries(
        Object.entries(patch).filter(([key]) => SECURITY_SETTINGS.has(key)),
      );
      const held = confirmed;
      confirmed = null;
      if (Object.keys(security).length > 0) {
        const preconfirmed =
          held &&
          Object.entries(held.patch).every(
            ([key, value]) => key in security && security[key] === value,
          )
            ? held
            : null;
        if (preconfirmed) {
          const applied = await applySecurity(preconfirmed.patch, preconfirmed.token);
          if (applied.ok !== false) {
            for (const key of Object.keys(preconfirmed.patch)) delete security[key];
          } else if (applied.errorCode !== 'permissionDenied') {
            return applied;
          }
          // A grant the backend no longer honours — it expired, or the vault
          // was locked since — is not a failure to report: the change falls
          // through to the path below, which asks for it again.
        }
        if (Object.keys(security).length > 0) {
          const applied = await applySecurity(security);
          if (applied.ok === false) return applied;
        }
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
