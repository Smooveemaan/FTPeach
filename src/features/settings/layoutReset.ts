import { normalizeLayoutSettings } from './useSettings.ts';
import type { SettingsState } from './useSettings.ts';
import type { AppSettings } from '../../platform/api/settings.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';

/**
 * A layout reset writes the defaults straight to the backend store, then
 * hands the result back here. It takes the group updater it changes rather
 * than eleven individual setters: the reset is one edit to the layout group
 * and one hydration of the resize state. Whether the log panel shows is left
 * as it was; only its size goes back to the default.
 */
interface LayoutResetTargets {
  updateLayout: (patch: Partial<SettingsState['layout']>) => void;
  hydrateSectionResizeFromSettings: (settings: AppSettings) => void;
}

interface LayoutApi {
  resetLayout: () => Promise<CommandResult & { settings?: AppSettings }>;
}

export function applyLayoutResetSettings(settings: AppSettings, targets: LayoutResetTargets) {
  targets.updateLayout(normalizeLayoutSettings(settings));
  targets.hydrateSectionResizeFromSettings(settings);
}

export async function resetLayoutFromApi(appApi: LayoutApi, targets: LayoutResetTargets) {
  const result = await appApi.resetLayout();
  if (!result.ok) return result;
  applyLayoutResetSettings(result.settings ?? {}, targets);
  return result;
}
