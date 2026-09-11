import { invoke as rawInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Theme } from '@tauri-apps/api/window';
import { createDragOutApi } from './api/dragOut.ts';
import { installConsoleForwarding } from './consoleForwarding.ts';
import { createFilesystemApi } from './api/filesystem.ts';
import { createProxyApi } from './api/proxy.ts';
import { createSessionApi } from './api/session.ts';
import { createSettingsApi } from './api/settings.ts';
import { createSitesApi } from './api/sites.ts';
import { createTabsApi } from './api/tabs.ts';
import { createTransferApi } from './api/transfers.ts';
import { createUpdaterApi } from './api/updater.ts';
import {
  checkedResponse,
  commandFailure,
  commandOutcome,
  describeUnknown,
  hasCommandOutcome,
  isLogEntryArray,
  isOpenWithChange,
  isPreviewProgress,
  isRecord,
  normalizeCommandError,
  normalizeInvokeResponse,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from './ipcContracts.ts';
import type {
  CommandResult,
  EventSubscription,
  InvokeArgs,
  InvokeResult,
  PayloadGuard,
} from './ipcContracts.ts';
import type { AppSettings } from './api/settings.ts';
import type { LogEntry } from '../shared/types.ts';

interface VaultStatus {
  configured: boolean;
  locked: boolean;
  systemUnlockAvailable: boolean;
  systemUnlockEnabled: boolean;
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
type ExportSettingsResult = CommandResult & { canceled?: boolean };
type ImportSettingsResult = CommandResult & {
  canceled?: boolean;
  settings?: AppSettings;
  sitesAdded?: number;
  sitesSkipped?: number;
  issues?: string[];
};
type OpenWithStartResult = CommandResult & { localPath?: string };

function isSaveFileResult(value: unknown): value is SaveFileResult {
  return hasCommandOutcome(value) && optionalBoolean(value.canceled) && optionalString(value.path);
}

function isSettingsMap(value: unknown): value is AppSettings | undefined {
  return value === undefined || (isRecord(value) && !Array.isArray(value));
}

function isResetLayoutResult(value: unknown): value is ResetLayoutResult {
  return hasCommandOutcome(value) && isSettingsMap(value.settings);
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

function isOpenWithStartResult(value: unknown): value is OpenWithStartResult {
  return hasCommandOutcome(value) && optionalString(value.localPath);
}

async function invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<InvokeResult<T>> {
  try {
    const sensitiveTarget = (() => {
      switch (command) {
        case 'fs_delete':
        case 'fs_reveal_path':
        case 'fs_open_document':
        case 'fs_execute_path':
        case 'open_with_start':
          return command === 'open_with_start'
            ? typeof args?.remotePath === 'string'
              ? args.remotePath
              : ''
            : typeof args?.localPath === 'string'
              ? args.localPath
              : '';
        case 'sites_reveal_secret':
          return `${describeUnknown(args?.id)}:${describeUnknown(args?.field)}`;
        case 'settings_reveal_proxy_password':
          return 'proxy';
        case 'vault_reset':
          return 'vault';
        case 'app_export_settings':
        case 'app_import_settings':
          return 'native-dialog';
        default:
          return null;
      }
    })();
    if (sensitiveTarget !== null) {
      const authorization = await rawInvoke<{ token: string }>(
        'plugin:sensitive|authorize_sensitive',
        { operation: command, target: sensitiveTarget },
      );
      return normalizeInvokeResponse(
        await rawInvoke<T>(`plugin:sensitive|${command}`, {
          ...args,
          authorizationToken: authorization.token,
        }),
      );
    }
    return normalizeInvokeResponse(await rawInvoke<T>(command, args));
  } catch (rawError) {
    const error = normalizeCommandError(rawError);
    return {
      ok: false,
      error: error.message,
      errorCode: error.code,
      diagnosticDetails: error.details,
    };
  }
}

function onEvent<T = unknown>(
  eventName: string,
  validate: PayloadGuard<T> = (_value: unknown): _value is T => true,
): EventSubscription<T> {
  return (callback) => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<unknown>(eventName, (event) => {
      if (validate(event.payload)) callback(event.payload);
      else console.error(`Ignored invalid IPC event payload: ${eventName}`, event.payload);
    }).then((fn: UnlistenFn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  };
}

export const tauriApi: Window['api'] = {
  session: createSessionApi(invoke),
  transfer: createTransferApi(invoke, onEvent),
  fsLocal: createFilesystemApi(invoke),
  sites: createSitesApi(invoke),
  tabs: createTabsApi(invoke),
  settings: createSettingsApi(invoke),
  proxy: createProxyApi(invoke),
  updater: createUpdaterApi(invoke, onEvent),
  openWith: {
    start: (
      connectionId: string,
      remotePath: string,
      id: string,
      application: string | null,
    ): Promise<OpenWithStartResult> =>
      checkedResponse(
        'open_with_start',
        invoke('open_with_start', { connectionId, remotePath, id, application }),
        isOpenWithStartResult,
        (raw): OpenWithStartResult => commandFailure('open_with_start', raw),
      ),
    stop: (id: string) => invoke('open_with_stop', { id }),
    onChanged: onEvent('openWith:changed', isOpenWithChange),
    onProgress: onEvent('preview:progress', isPreviewProgress),
  },
  dragOut: createDragOutApi(invoke),
  log: {
    setFileLogging: (enabled: boolean | undefined) => invoke('log_set_file_logging', { enabled }),
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
    setup: (masterPassword: string) => commandOutcome(invoke, 'vault_setup', { masterPassword }),
    unlock: (masterPassword: string) => commandOutcome(invoke, 'vault_unlock', { masterPassword }),
    lock: () => commandOutcome(invoke, 'vault_lock'),
    enableSystemUnlock: () => commandOutcome(invoke, 'vault_enable_system_unlock'),
    unlockSystem: () => commandOutcome(invoke, 'vault_unlock_system'),
    disableSystemUnlock: () => commandOutcome(invoke, 'vault_disable_system_unlock'),
    changePassword: (oldPassword: string, newPassword: string) =>
      commandOutcome(invoke, 'vault_change_password', { oldPassword, newPassword }),
    reset: () => commandOutcome(invoke, 'vault_reset'),
    useSystemProtection: (masterPassword: string) =>
      commandOutcome(invoke, 'vault_use_system_protection', { masterPassword }),
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
     * Three surfaces, none of which CSS can reach, all of which have to follow
     * the theme the document just switched to:
     *
     *   - `setTheme` is the OS-level dark/light flag. On 'system' it takes
     *     null, handing the choice back to the setting the CSS resolves
     *     against too.
     *   - `setBackgroundColor` is the window surface under the webview, seen
     *     while a resize outruns the repaint. tauri.conf.json can only give it
     *     one static value, so it is wrong in one of the two themes until this
     *     restates it.
     *   - `app_set_window_border` is the 1px border Windows 11 draws outside
     *     the client area. `setTheme` does not recolor it on a frameless
     *     window -- see the command in commands/app.rs.
     */
    setWindowTheme: (
      theme: string,
      colors: { background: [number, number, number]; border: [number, number, number] },
    ) => {
      const native: Theme | null = theme === 'dark' || theme === 'light' ? theme : null;
      const appWindow = getCurrentWindow();
      void appWindow.setTheme(native);
      void appWindow.setBackgroundColor(colors.background);
      const [red, green, blue] = colors.border;
      void invoke('app_set_window_border', { red, green, blue });
    },
    resetLayout: (): Promise<ResetLayoutResult> =>
      checkedResponse(
        'app_reset_layout',
        invoke('app_reset_layout'),
        isResetLayoutResult,
        (raw): ResetLayoutResult => commandFailure('app_reset_layout', raw),
      ),
    exportSettings: (options: Record<string, unknown>): Promise<ExportSettingsResult> =>
      checkedResponse(
        'app_export_settings',
        invoke('app_export_settings', { options }),
        isExportSettingsResult,
        (raw): ExportSettingsResult => commandFailure('app_export_settings', raw),
      ),
    importSettings: (options: Record<string, unknown>): Promise<ImportSettingsResult> =>
      checkedResponse(
        'app_import_settings',
        invoke('app_import_settings', { options }),
        isImportSettingsResult,
        (raw): ImportSettingsResult => commandFailure('app_import_settings', raw),
      ),
    openExternal: (url: string) => invoke('app_open_external', { url }),
    openDevtools: () => invoke('debug_open_devtools'),
  },
  notifications: {
    transfersComplete: (summary: Record<string, unknown>) =>
      invoke('notifications_transfers_complete', { summary }),
  },
  tray: {
    setLabels: (show: string, quit: string) => invoke('tray_set_labels', { show, quit }),
  },
};

/**
 * Installs the implementation behind `platform/api`. Only `main.tsx` calls
 * this, and only inside Tauri; keeping the assignment here is what lets the
 * boundary checker say `window.api` appears nowhere outside `platform/`.
 */
let disposeConsoleForwarding: (() => void) | null = null;

export function installTauriApi(): void {
  window.api = tauriApi;
  disposeConsoleForwarding?.();
  disposeConsoleForwarding = installConsoleForwarding(rawInvoke);
}
