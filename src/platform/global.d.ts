import type { createFilesystemApi } from './api/filesystem.ts';
import type { createProxyApi } from './api/proxy.ts';
import type { createSessionApi } from './api/session.ts';
import type { createSettingsApi } from './api/settings.ts';
import type { createSitesApi } from './api/sites.ts';
import type { createTabsApi } from './api/tabs.ts';
import type { createTransferApi } from './api/transfers.ts';
import type { createTrayApi } from './api/tray.ts';
import type { createUpdaterApi } from './api/updater.ts';
import type {
  AppSettings,
  ExportSettingsResult,
  ImportSettingsResult,
  SettingsTransferOptions,
} from './api/settings.ts';
import type {
  CommandResult,
  OpenWithChange,
  PreviewProgress,
  RecoveredEdit,
  Unsubscribe,
  VaultLocked,
} from './ipcContracts.ts';
import type { DragOutFile } from './api/dragOut.ts';
import type { LogEntry } from '../shared/logEntry.ts';
import type { SiteProtocol } from '../shared/siteContracts.ts';

export {};

declare global {
  interface Window {
    api: {
      fsLocal: ReturnType<typeof createFilesystemApi>;
      proxy: ReturnType<typeof createProxyApi>;
      session: ReturnType<typeof createSessionApi>;
      settings: ReturnType<typeof createSettingsApi>;
      sites: ReturnType<typeof createSitesApi>;
      tabs: ReturnType<typeof createTabsApi>;
      transfer: ReturnType<typeof createTransferApi>;
      updater: ReturnType<typeof createUpdaterApi>;
      vault: {
        status: () => Promise<{
          configured: boolean;
          locked: boolean;
          systemUnlockAvailable: boolean;
          systemUnlockEnabled: boolean;
          portable?: boolean;
        }>;
        unlock: (masterPassword: string) => Promise<CommandResult>;
        unlockSystem: () => Promise<CommandResult>;
        lock: () => Promise<CommandResult>;
        /** Tells the backend the user has been seen, postponing the idle lock. */
        noteActivity: () => void;
        /** The backend locked the vault itself; the payload says why. */
        onLocked: (callback: (locked: VaultLocked) => void) => Unsubscribe;
        /** The vault was opened, by whichever window or prompt did it. */
        onUnlocked: (callback: () => void) => Unsubscribe;
        setup: (masterPassword: string) => Promise<CommandResult>;
        enableSystemUnlock: () => Promise<CommandResult>;
        disableSystemUnlock: () => Promise<CommandResult>;
        changePassword: (oldPassword: string, newPassword: string) => Promise<CommandResult>;
        reset: () => Promise<CommandResult>;
        useSystemProtection: () => Promise<CommandResult>;
      };
      notifications: {
        transfersComplete: (summary: {
          succeeded: number;
          failed: number;
          title: string;
          body: string;
        }) => Promise<unknown>;
      };
      shortcuts: {
        onKeyDown: (callback: (event: KeyboardEvent) => void) => () => void;
      };
      log: {
        setFileLogging: (enabled: boolean | undefined) => unknown;
        /** Opens the folder the log files are written to. */
        openFolder: (folder: string) => Promise<CommandResult>;
        /** The protocol log the backend still holds, oldest first; empty on failure. */
        recent: () => Promise<LogEntry[]>;
        save: (content: string) => Promise<CommandResult & { canceled?: boolean; path?: string }>;
        exportDiagnostics: () => Promise<CommandResult & { canceled?: boolean; path?: string }>;
        onMessage: (callback: (batch: LogEntry[]) => void) => Unsubscribe;
      };
      app: {
        version: () => Promise<string>;
        systemHourCycle: () => Promise<'h12' | 'h23' | null>;
        setWindowTheme: (
          theme: string,
          colors: {
            background: [number, number, number];
            border: [number, number, number];
          },
        ) => void;
        resetLayout: () => Promise<CommandResult & { settings?: AppSettings }>;
        exportSettings: (options: SettingsTransferOptions) => Promise<ExportSettingsResult>;
        importSettings: (options: SettingsTransferOptions) => Promise<ImportSettingsResult>;
        openExternal: (url: string) => Promise<unknown>;
        openDevtools: () => Promise<unknown>;
        /** Quits without asking about running transfers again. */
        quit: (preserveEdits?: boolean) => Promise<unknown>;
      };
      tray: ReturnType<typeof createTrayApi>;
      openWith: {
        start: (
          connectionId: string,
          remotePath: string,
          id: string,
          application: string | null,
        ) => Promise<CommandResult & { id?: string; localPath?: string }>;
        stop: (id: string) => Promise<unknown>;
        markSynced: (id: string, revision: string) => Promise<CommandResult>;
        recoveredEdits: () => Promise<RecoveredEdit[]>;
        revealRecoveredEdits: () => Promise<CommandResult>;
        discardRecoveredEdits: () => Promise<CommandResult>;
        onChanged: (callback: (payload: OpenWithChange) => void) => Unsubscribe;
        onProgress: (callback: (payload: PreviewProgress) => void) => Unsubscribe;
      };
      dragOut: {
        start: (
          connectionId: string,
          protocol: SiteProtocol,
          files: DragOutFile[],
        ) => Promise<CommandResult>;
        startLocal: (paths: string[]) => Promise<CommandResult>;
      };
    };
  }
}
