import type { createFilesystemApi } from './api/filesystem.ts';
import type { createProxyApi } from './api/proxy.ts';
import type { createSessionApi } from './api/session.ts';
import type { createSettingsApi } from './api/settings.ts';
import type { createSitesApi } from './api/sites.ts';
import type { createTabsApi } from './api/tabs.ts';
import type { createTransferApi } from './api/transfers.ts';
import type { createUpdaterApi } from './api/updater.ts';
import type { AppSettings } from './api/settings.ts';
import type { CommandResult, OpenWithChange, PreviewProgress } from './ipcContracts.ts';
import type { DragOutFile } from './api/dragOut.ts';
import type { LogEntry, SiteProtocol } from '../shared/types.ts';

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
        }>;
        unlock: (masterPassword: string) => Promise<CommandResult>;
        unlockSystem: () => Promise<CommandResult>;
        lock: () => Promise<CommandResult>;
        setup: (masterPassword: string) => Promise<CommandResult>;
        enableSystemUnlock: () => Promise<CommandResult>;
        disableSystemUnlock: () => Promise<CommandResult>;
        changePassword: (oldPassword: string, newPassword: string) => Promise<CommandResult>;
        reset: () => Promise<CommandResult>;
        useSystemProtection: (masterPassword: string) => Promise<CommandResult>;
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
        setEnabled: (enabled: boolean | undefined) => unknown;
        setFileLogging: (enabled: boolean | undefined) => unknown;
        save: (content: string) => Promise<CommandResult & { canceled?: boolean; path?: string }>;
        exportDiagnostics: (
          content: string,
        ) => Promise<CommandResult & { canceled?: boolean; path?: string }>;
        onMessage: (callback: (batch: LogEntry[]) => void) => () => void;
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
        exportSettings: (
          options: Record<string, unknown>,
        ) => Promise<CommandResult & { canceled?: boolean }>;
        importSettings: (options: Record<string, unknown>) => Promise<
          CommandResult & {
            canceled?: boolean;
            settings?: AppSettings;
            sitesAdded?: number;
            sitesSkipped?: number;
            issues?: string[];
          }
        >;
        openExternal: (url: string) => Promise<unknown>;
        openDevtools: () => Promise<unknown>;
      };
      tray: {
        setLabels: (show: string, quit: string) => Promise<unknown>;
      };
      openWith: {
        start: (
          connectionId: string,
          remotePath: string,
          id: string,
          application: string | null,
        ) => Promise<CommandResult & { localPath?: string }>;
        stop: (id: string) => Promise<unknown>;
        onChanged: (callback: (payload: OpenWithChange) => void) => () => void;
        onProgress: (callback: (payload: PreviewProgress) => void) => () => void;
      };
      dragOut: {
        start: (
          connectionId: string,
          protocol: SiteProtocol,
          files: DragOutFile[],
        ) => Promise<CommandResult>;
      };
    };
  }
}
