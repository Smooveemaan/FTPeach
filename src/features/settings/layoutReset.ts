import SETTINGS_DEFAULTS from '../../shared/settingsDefaults.ts';
import {
  normalizeColumnsSetting,
  normalizeStringArraySetting,
  normalizeWidthsSetting,
} from './useSettings.ts';
import type { ColumnWidths, PaneOrientation, SettingsState } from './useSettings.ts';
import type { AppSettings } from '../../platform/api/settings.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';

/**
 * A layout reset writes the defaults straight to the backend store, then
 * hands the result back here. It takes the two group updaters it changes
 * rather than eleven individual setters: the reset is one edit to the layout
 * group, one to logging, and one hydration of the resize state.
 */
interface LayoutResetTargets {
  updateLayout: (patch: Partial<SettingsState['layout']>) => void;
  updateLogging: (patch: Partial<SettingsState['logging']>) => void;
  hydrateSectionResizeFromSettings: (settings: AppSettings) => void;
}

interface LayoutApi {
  resetLayout: () => Promise<CommandResult & { settings?: AppSettings }>;
}

export function applyLayoutResetSettings(settings: AppSettings, targets: LayoutResetTargets) {
  targets.updateLayout({
    localColumns: normalizeColumnsSetting(settings.localColumns, SETTINGS_DEFAULTS.localColumns),
    remoteColumns: normalizeColumnsSetting(settings.remoteColumns, SETTINGS_DEFAULTS.remoteColumns),
    localColumnWidths: normalizeWidthsSetting(
      settings.localColumnWidths,
      SETTINGS_DEFAULTS.localColumnWidths,
    ),
    remoteColumnWidths: normalizeWidthsSetting(
      settings.remoteColumnWidths,
      SETTINGS_DEFAULTS.remoteColumnWidths,
    ),
    transferColumnWidths:
      settings.transferColumnWidths && typeof settings.transferColumnWidths === 'object'
        ? (settings.transferColumnWidths as ColumnWidths)
        : SETTINGS_DEFAULTS.transferColumnWidths,
    transferHiddenColumns: normalizeStringArraySetting(
      settings.transferHiddenColumns,
      SETTINGS_DEFAULTS.transferHiddenColumns,
    ),
    transferColumnOrder: normalizeStringArraySetting(
      settings.transferColumnOrder,
      SETTINGS_DEFAULTS.transferColumnOrder,
    ),
    showLocalPane: settings.showLocalPane !== false,
    showRemotePane: settings.showRemotePane !== false,
    showTransferQueue: settings.showTransferQueue !== false,
    paneOrientation:
      settings.paneOrientation === 'horizontal' || settings.paneOrientation === 'vertical'
        ? settings.paneOrientation
        : (SETTINGS_DEFAULTS.paneOrientation as PaneOrientation),
  });
  targets.updateLogging({ logEnabled: !!settings.logEnabled });
  targets.hydrateSectionResizeFromSettings(settings);
}

export async function resetLayoutFromApi(appApi: LayoutApi, targets: LayoutResetTargets) {
  const result = await appApi.resetLayout();
  if (!result.ok) return result;
  applyLayoutResetSettings(result.settings ?? {}, targets);
  return result;
}
