import { useCallback } from 'react';
import { api } from '../../platform/api/index.ts';
import type { AppSettings } from '../../platform/api/settings.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { commandResultError } from '../../shared/errorMessages.ts';

export interface ImportSitesSummary {
  sitesAdded: number;
  sitesSkipped: number;
}

interface SettingsTransferApi {
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
}

interface UseSettingsTransferOptions {
  applySettings: (settings: AppSettings) => void;
  refreshSites: () => unknown;
  reportError: (error: unknown) => void;
  appApi?: SettingsTransferApi;
}

export interface SettingsTransferModel {
  exportSettings: (options: Record<string, unknown>) => Promise<boolean>;
  importSettings: (options: Record<string, unknown>) => Promise<ImportSitesSummary | undefined>;
}

export function useSettingsTransfer({
  applySettings,
  refreshSites,
  reportError,
  appApi = api.app,
}: UseSettingsTransferOptions): SettingsTransferModel {
  const exportSettings = useCallback(
    async (options: Record<string, unknown>): Promise<boolean> => {
      const result = await appApi.exportSettings(options);
      if (!result.ok) {
        if (!result.canceled) reportError(commandResultError(result));
        return false;
      }
      return true;
    },
    [appApi, reportError],
  );

  const importSettings = useCallback(
    async (options: Record<string, unknown>): Promise<ImportSitesSummary | undefined> => {
      const result = await appApi.importSettings(options);
      if (!result.ok) {
        if (!result.canceled) reportError(commandResultError(result));
        return undefined;
      }
      if (result.settings) applySettings(result.settings);
      if (result.sitesAdded) refreshSites();
      return { sitesAdded: result.sitesAdded ?? 0, sitesSkipped: result.sitesSkipped ?? 0 };
    },
    [appApi, applySettings, refreshSites, reportError],
  );

  return { exportSettings, importSettings };
}
