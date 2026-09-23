import { useCallback } from 'react';
import { api } from '../../platform/api/index.ts';
import type { AppSettings, SettingsTransferOptions } from '../../platform/api/settings.ts';
import { commandResultError } from '../../shared/errorMessages.ts';

export interface ImportSitesSummary {
  sitesAdded: number;
  sitesSkipped: number;
}

type SettingsTransferApi = Pick<Window['api']['app'], 'exportSettings' | 'importSettings'>;

interface UseSettingsTransferOptions {
  applySettings: (settings: AppSettings) => void;
  refreshSites: () => unknown;
  reportError: (error: unknown) => void;
  appApi?: SettingsTransferApi;
}

export interface SettingsTransferModel {
  exportSettings: (options: SettingsTransferOptions) => Promise<boolean>;
  importSettings: (options: SettingsTransferOptions) => Promise<ImportSitesSummary | undefined>;
}

export function useSettingsTransfer({
  applySettings,
  refreshSites,
  reportError,
  appApi = api.app,
}: UseSettingsTransferOptions): SettingsTransferModel {
  const exportSettings = useCallback(
    async (options: SettingsTransferOptions): Promise<boolean> => {
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
    async (options: SettingsTransferOptions): Promise<ImportSitesSummary | undefined> => {
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
