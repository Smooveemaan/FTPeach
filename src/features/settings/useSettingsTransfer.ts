import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../platform/api/index.ts';
import type { AppSettings, SettingsTransferOptions } from '../../platform/api/settings.ts';
import { commandResultError } from '../../shared/errorMessages.ts';
import type { NoticeMessage } from '../../hooks/useStatusNotice.ts';

type SettingsTransferApi = Pick<Window['api']['app'], 'exportSettings' | 'importSettings'>;

interface UseSettingsTransferOptions {
  applySettings: (settings: AppSettings) => void;
  refreshSites: () => unknown;
  reportError: (error: unknown) => void;
  appApi?: SettingsTransferApi;
}

/**
 * Both resolve to a message saying what a finished export or import covered,
 * for whichever status line started it; undefined when cancelled or failed.
 */
export interface SettingsTransferModel {
  exportSettings: (options: SettingsTransferOptions) => Promise<NoticeMessage | undefined>;
  importSettings: (options: SettingsTransferOptions) => Promise<NoticeMessage | undefined>;
}

const PARTS = ['includeSettings', 'includeBookmarks', 'includeLocalPaths'] as const;

export function useSettingsTransfer({
  applySettings,
  refreshSites,
  reportError,
  appApi = api.app,
}: UseSettingsTransferOptions): SettingsTransferModel {
  const { t } = useTranslation();
  const partNames = useCallback(
    (options: SettingsTransferOptions) =>
      PARTS.filter((part) => options[part])
        .map((part) => t(`exportSettingsDialog.${part}`))
        .join(', '),
    [t],
  );

  const exportSettings = useCallback(
    async (options: SettingsTransferOptions): Promise<NoticeMessage | undefined> => {
      const result = await appApi.exportSettings(options);
      if (!result.ok) {
        if (!result.canceled) reportError(commandResultError(result));
        return undefined;
      }
      return {
        text: t('statusBar.exported', { parts: partNames(options) }),
        short: t('statusBar.exportedShort'),
      };
    },
    [appApi, reportError, t, partNames],
  );

  const importSettings = useCallback(
    async (options: SettingsTransferOptions): Promise<NoticeMessage | undefined> => {
      const result = await appApi.importSettings(options);
      if (!result.ok) {
        if (!result.canceled) reportError(commandResultError(result));
        return undefined;
      }
      if (result.settings) applySettings(result.settings);
      if (result.sitesAdded) refreshSites();
      const added = result.sitesAdded ?? 0;
      const skipped = result.sitesSkipped ?? 0;
      // Name only what actually came in: settings the file had, sites that were added.
      const imported = {
        includeSettings: options.includeSettings && !!result.settings,
        includeBookmarks: options.includeBookmarks && added > 0,
        includeLocalPaths: options.includeLocalPaths && added > 0,
      };
      const anything = imported.includeSettings || added > 0;
      const phrase = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
      const addedPart = added > 0 ? t('statusBar.importAdded', { count: added }) : null;
      // The short form drops what the parts were -- they were just ticked --
      // and keeps the numbers.
      return {
        text: phrase(
          anything
            ? t('statusBar.imported', { parts: partNames(imported) })
            : t('statusBar.importNothingNew'),
          addedPart,
          skipped > 0 ? t('statusBar.importSkipped', { count: skipped }) : null,
        ),
        short: phrase(
          t(anything ? 'statusBar.importedShort' : 'statusBar.importNothingNewShort'),
          addedPart,
          skipped > 0 ? t('statusBar.importSkippedShort', { count: skipped }) : null,
        ),
      };
    },
    [appApi, applySettings, refreshSites, reportError, t, partNames],
  );

  return { exportSettings, importSettings };
}
