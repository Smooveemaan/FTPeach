import { invoke as rawInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Theme } from '@tauri-apps/api/window';
import { createDragOutApi } from './api/dragOut.ts';
import { installConsoleForwarding } from './consoleForwarding.ts';
import { createFilesystemApi } from './api/filesystem.ts';
import { createProxyApi } from './api/proxy.ts';
import { createSessionApi } from './api/session.ts';
import { createSettingsApi, securityAuthorizationTarget } from './api/settings.ts';
import { createSitesApi } from './api/sites.ts';
import { createTabsApi } from './api/tabs.ts';
import { createTransferApi } from './api/transfers.ts';
import { createTrayApi } from './api/tray.ts';
import { createUpdaterApi } from './api/updater.ts';
import {
  checkedResponse,
  commandFailure,
  describeUnknown,
  hasCommandOutcome,
  isLogEntryArray,
  isOpenWithChange,
  isRecoveredEditArray,
  isVaultLocked,
  isPreviewProgress,
  isRecord,
  normalizeCommandError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  voidOutcome,
} from './ipcContracts.ts';
import type { VaultLocked } from './ipcContracts.ts';
import type {
  CommandResult,
  EventSubscription,
  InvokeArgs,
  InvokeResult,
  PayloadGuard,
  RecoveredEdit,
} from './ipcContracts.ts';
import type {
  AppSettings,
  ExportSettingsResult,
  ImportSettingsResult,
  SettingsTransferOptions,
} from './api/settings.ts';
import type { LogEntry } from '../shared/logEntry.ts';
import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { flushShutdownState } from './shutdownPersistence.ts';
import './persistSetting.ts';

interface VaultStatus {
  configured: boolean;
  locked: boolean;
  systemUnlockAvailable: boolean;
  systemUnlockEnabled: boolean;
  /** This copy keeps its data beside the program. */
  portable?: boolean;
}

function isVaultStatus(value: unknown): value is VaultStatus {
  return (
    isRecord(value) &&
    typeof value.configured === 'boolean' &&
    typeof value.locked === 'boolean' &&
    typeof value.systemUnlockAvailable === 'boolean' &&
    typeof value.systemUnlockEnabled === 'boolean'
  );
}

type SaveFileResult = CommandResult & { canceled?: boolean; path?: string };
type ResetLayoutResult = CommandResult & { settings?: AppSettings };
type OpenWithStartResult = CommandResult & { id?: string; localPath?: string };

function isSaveFileResult(value: unknown): value is SaveFileResult {
  return hasCommandOutcome(value) && optionalBoolean(value.canceled) && optionalString(value.path);
}

function isSettingsMap(value: unknown): value is AppSettings | undefined {
  return value === undefined || (isRecord(value) && !Array.isArray(value));
}

/** What `app_reset_layout` answers when it worked. */
function isResetLayout(value: unknown): value is { settings: AppSettings } {
  return isRecord(value) && isRecord(value.settings) && !Array.isArray(value.settings);
}

function isExportSettingsResult(value: unknown): value is ExportSettingsResult {
  return hasCommandOutcome(value) && optionalBoolean(value.canceled);
}

function isImportSettingsResult(value: unknown): value is ImportSettingsResult {
  return (
    hasCommandOutcome(value) &&
    optionalBoolean(value.canceled) &&
    isSettingsMap(value.settings) &&
    optionalNumber(value.sitesAdded) &&
    optionalNumber(value.sitesSkipped) &&
    (value.issues === undefined ||
      (Array.isArray(value.issues) && value.issues.every((issue) => typeof issue === 'string')))
  );
}

/** What `open_with_start` answers when the editor was opened. */
function isOpenWithStarted(value: unknown): value is { id: string; localPath: string } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.localPath === 'string';
}

/**
 * The language the window is showing right now, which the settings dialog
 * changes live, long before the change is saved. The backend writes its
 * confirmation windows in it so they never arrive in the language the user
 * has just moved away from.
 */
function displayLocale(): string {
  return document.documentElement.lang;
}

/**
 * Obtains a grant for a sensitive command. The backend confirms it with the
 * user in its own window first, and rejects when they decline.
 */
async function authorizeSensitive(operation: string, target: string): Promise<string> {
  const grant = await rawInvoke<{ token: string }>('plugin:sensitive|authorize_sensitive', {
    operation,
    target,
    locale: displayLocale(),
  });
  return grant.token;
}

async function invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<InvokeResult<T>> {
  try {
    const sensitiveTarget = (() => {
      switch (command) {
        case 'fs_delete':
        case 'fs_reveal_path':
        case 'fs_open_document':
        case 'fs_execute_path':
          return typeof args?.localPath === 'string' ? args.localPath : '';
        case 'open_with_start':
          // The grant covers the whole request: which server, which file and
          // which program. The backend resolves the rest itself.
          return JSON.stringify({
            connectionId: args?.connectionId,
            remotePath: args?.remotePath,
            application: args?.application ?? null,
          });
        case 'sites_reveal_secret':
          return `${describeUnknown(args?.id)}:${describeUnknown(args?.field)}`;
        case 'settings_reveal_proxy_password':
          return 'proxy';
        case 'vault_reset':
        case 'vault_use_system_protection':
          return 'vault';
        case 'settings_set_security':
          return securityAuthorizationTarget(isRecord(args?.patch) ? args.patch : {});
        case 'sites_save': {
          // The backend compares the recipient with the stored bookmark; the
          // secrets themselves stay out of the authorization request.
          const site = isRecord(args?.site) ? args.site : {};
          const { password, keyPassphrase: _keyPassphrase, ...rest } = site;
          return JSON.stringify({
            ...rest,
            password: typeof password === 'string' && password !== '',
          });
        }
        case 'session_trust_host_key':
          // The request is already the grant's target: the backend parses
          // the same string it confirmed.
          return typeof args?.request === 'string' ? args.request : '';
        case 'app_export_settings':
        case 'app_import_settings':
          return 'native-dialog';
        default:
          return null;
      }
    })();
    if (sensitiveTarget !== null) {
      // A caller that already holds a grant — the settings dialog confirms a
      // relaxed protection at the switch, not at Save — hands it over here
      // instead of having the user confirm the same change a second time.
      const authorizationToken =
        typeof args?.authorizationToken === 'string'
          ? args.authorizationToken
          : await authorizeSensitive(command, sensitiveTarget);
      return await rawInvoke<T>(`plugin:sensitive|${command}`, { ...args, authorizationToken });
    }
    return await rawInvoke<T>(command, args);
  } catch (rawError) {
    const error = normalizeCommandError(rawError);
    // A failure with a code is an answer the caller shows where it happened: a
    // wrong password, a missing file, a declined confirmation. Only one nothing
    // classified is worth a line in the application log, with the detail that
    // says where it came from; the log redacts what it writes.
    if (error.code === 'internal') {
      console.warn(`${command} failed: ${error.message}`, error.details ?? '');
    }
    return {
      ok: false,
      error: error.message,
      errorCode: error.code,
      diagnosticDetails: error.details,
    };
  }
}

export function onEvent<T = unknown>(
  eventName: string,
  validate: PayloadGuard<T> = (_value: unknown): _value is T => true,
): EventSubscription<T> {
  return (callback) => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    const ready = listen<unknown>(eventName, (event) => {
      if (validate(event.payload)) callback(event.payload);
      else console.error(`Ignored invalid IPC event payload: ${eventName}`, event.payload);
    }).then(
      (fn: UnlistenFn) => {
        // Stopped before the listener existed: remove it now it does.
        if (cancelled) fn();
        else unlisten = fn;
        return !cancelled;
      },
      (error: unknown) => {
        // Without the listener the view silently stops updating; say so once
        // instead of retrying blindly or leaving an unhandled rejection.
        if (!cancelled) {
          reportAsyncFailure(
            new Error(
              `Could not subscribe to ${eventName}: ${error instanceof Error ? error.message : describeUnknown(error)}`,
            ),
          );
        }
        return false;
      },
    );
    return Object.assign(
      () => {
        cancelled = true;
        unlisten?.();
        unlisten = null;
      },
      { ready },
    );
  };
}

export const tauriApi: Window['api'] = {
  session: createSessionApi(invoke),
  transfer: createTransferApi(invoke, onEvent),
  fsLocal: createFilesystemApi(invoke),
  sites: createSitesApi(invoke),
  tabs: createTabsApi(invoke),
  settings: createSettingsApi(invoke, authorizeSensitive),
  proxy: createProxyApi(invoke),
  updater: createUpdaterApi(invoke, onEvent),
  openWith: {
    start: (
      connectionId: string,
      remotePath: string,
      id: string,
      application: string | null,
      choose = false,
    ): Promise<OpenWithStartResult> =>
      checkedResponse(
        'open_with_start',
        invoke('open_with_start', { connectionId, remotePath, id, application, choose }),
        isOpenWithStarted,
        (raw): OpenWithStartResult => commandFailure('open_with_start', raw),
      ).then((result) => ('ok' in result ? result : { ok: true, ...result })),
    stop: (id: string) => voidOutcome(invoke, 'open_with_stop', { id }),
    markSynced: (id: string, revision: string) =>
      voidOutcome(invoke, 'open_with_mark_synced', { id, revision }),
    recoveredEdits: (): Promise<RecoveredEdit[]> =>
      checkedResponse(
        'open_with_recovered_edits',
        invoke('open_with_recovered_edits'),
        isRecoveredEditArray,
        (): RecoveredEdit[] => [],
      ),
    revealRecoveredEdits: () => voidOutcome(invoke, 'open_with_reveal_recovered_edits'),
    discardRecoveredEdits: () => voidOutcome(invoke, 'open_with_discard_recovered_edits'),
    onChanged: onEvent('openWith:changed', isOpenWithChange),
    onProgress: onEvent('preview:progress', isPreviewProgress),
  },
  dragOut: createDragOutApi(invoke),
  log: {
    setFileLogging: (enabled: boolean | undefined) => invoke('log_set_file_logging', { enabled }),
    openFolder: (folder: string) => voidOutcome(invoke, 'log_open_folder', { folder }),
    recent: (): Promise<LogEntry[]> =>
      checkedResponse('log_recent', invoke('log_recent'), isLogEntryArray, (): LogEntry[] => []),
    save: (content: string): Promise<SaveFileResult> =>
      checkedResponse(
        'log_save',
        invoke('log_save', { content }),
        isSaveFileResult,
        (raw): SaveFileResult => commandFailure('log_save', raw),
      ),
    exportDiagnostics: (): Promise<SaveFileResult> =>
      checkedResponse(
        'log_export_diagnostics',
        invoke('log_export_diagnostics'),
        isSaveFileResult,
        (raw): SaveFileResult => commandFailure('log_export_diagnostics', raw),
      ),
    onMessage: onEvent<LogEntry[]>('protocol:log', isLogEntryArray),
  },
  shortcuts: {
    onKeyDown: (callback: (event: KeyboardEvent) => void) => {
      const listener = (event: KeyboardEvent) => callback(event);
      window.addEventListener('keydown', listener, { capture: true });
      return () => window.removeEventListener('keydown', listener, { capture: true });
    },
  },
  vault: {
    status: async (): Promise<VaultStatus> => {
      const result = await invoke<VaultStatus>('vault_status');
      if (isVaultStatus(result)) return result;
      throw new Error(
        (isRecord(result) && typeof result.error === 'string' && result.error) ||
          'Unable to read vault status.',
      );
    },
    setup: (masterPassword: string) => voidOutcome(invoke, 'vault_setup', { masterPassword }),
    unlock: (masterPassword: string) => voidOutcome(invoke, 'vault_unlock', { masterPassword }),
    lock: () => voidOutcome(invoke, 'vault_lock'),
    // Reporting that the user is here can only postpone the backend's idle
    // lock, so a failed report needs no handling beyond not throwing.
    noteActivity: () => {
      void invoke('vault_note_activity').catch(() => {});
    },
    onLocked: onEvent<VaultLocked>('vault:locked', isVaultLocked),
    onUnlocked: onEvent('vault:unlocked'),
    enableSystemUnlock: () => voidOutcome(invoke, 'vault_enable_system_unlock'),
    unlockSystem: () => voidOutcome(invoke, 'vault_unlock_system'),
    disableSystemUnlock: () => voidOutcome(invoke, 'vault_disable_system_unlock'),
    changePassword: (oldPassword: string, newPassword: string) =>
      voidOutcome(invoke, 'vault_change_password', { oldPassword, newPassword }),
    reset: () => voidOutcome(invoke, 'vault_reset'),
    // The master password is asked for by the backend's confirmation window.
    useSystemProtection: () => voidOutcome(invoke, 'vault_use_system_protection'),
  },
  app: {
    version: async (): Promise<string> => {
      const result = await invoke<string>('app_version');
      if (typeof result === 'string') return result;
      throw new Error(result.error ?? 'Unable to read application version.');
    },
    systemHourCycle: async (): Promise<'h12' | 'h23' | null> => {
      const result = await invoke<string | null>('app_system_hour_cycle');
      return result === 'h12' || result === 'h23' ? result : null;
    },
    /*
     * Native appearance, which CSS cannot reach, has to follow
     * the theme the document just switched to:
     *
     *   - `setTheme` is the OS-level dark/light flag. On 'system' it takes
     *     null, handing the choice back to the setting the CSS resolves
     *     against too.
     *   - WebviewWindow.setBackgroundColor updates both the host window and
     *     WebView2's default background. Window.setBackgroundColor alone leaves
     *     the webview at its startup color when the theme changes.
     *   - `app_set_window_border` is the 1px border Windows 11 draws outside
     *     the client area. `setTheme` does not recolor it on a frameless
     *     window -- see the command in commands/app.rs.
     */
    setWindowTheme: (
      theme: string,
      colors: { background: [number, number, number]; border: [number, number, number] },
    ) => {
      const native: Theme | null = theme === 'dark' || theme === 'light' ? theme : null;
      const appWindow = getCurrentWebviewWindow();
      void appWindow.setTheme(native).catch(reportAsyncFailure);
      void appWindow.setBackgroundColor([...colors.background, 255]).catch(reportAsyncFailure);
      const [red, green, blue] = colors.border;
      void invoke('app_set_window_border', { red, green, blue });
    },
    resetLayout: (): Promise<ResetLayoutResult> =>
      checkedResponse(
        'app_reset_layout',
        invoke('app_reset_layout'),
        isResetLayout,
        (raw): ResetLayoutResult => commandFailure('app_reset_layout', raw),
      ).then((result) => ('ok' in result ? result : { ok: true, ...result })),
    exportSettings: (options: SettingsTransferOptions): Promise<ExportSettingsResult> =>
      checkedResponse(
        'app_export_settings',
        invoke('app_export_settings', { options }),
        isExportSettingsResult,
        (raw): ExportSettingsResult => commandFailure('app_export_settings', raw),
      ),
    importSettings: (options: SettingsTransferOptions): Promise<ImportSettingsResult> =>
      checkedResponse(
        'app_import_settings',
        invoke('app_import_settings', { options }),
        isImportSettingsResult,
        (raw): ImportSettingsResult => commandFailure('app_import_settings', raw),
      ),
    openExternal: (url: string) => invoke('app_open_external', { url }),
    openDevtools: () => invoke('debug_open_devtools'),
    quit: (preserveEdits = false) => invoke('app_quit', { preserveEdits }),
  },
  notifications: {
    transfersComplete: (summary: Record<string, unknown>) =>
      invoke('notifications_transfers_complete', { summary }),
  },
  tray: createTrayApi(invoke, onEvent),
};

/**
 * Installs the implementation behind `platform/api`. Only `main.tsx` calls
 * this, and only inside Tauri; keeping the assignment here is what lets the
 * boundary checker say `window.api` appears nowhere outside `platform/`.
 */
let disposeConsoleForwarding: (() => void) | null = null;
let disposeShutdownListener: UnlistenFn | null = null;

export async function installTauriApi(): Promise<void> {
  window.api = tauriApi;
  disposeConsoleForwarding?.();
  disposeConsoleForwarding = installConsoleForwarding(rawInvoke);
  disposeShutdownListener?.();
  disposeShutdownListener = await listen<{ requestId: string }>('app:flush-state', (event) => {
    const requestId = event.payload.requestId;
    if (typeof requestId !== 'string') return;
    void flushShutdownState()
      .then((ok) => rawInvoke('app_state_flushed', { requestId, ok }))
      .catch((error: unknown) => console.error('Shutdown state acknowledgement failed', error));
  });
}
