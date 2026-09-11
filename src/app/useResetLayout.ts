import type { SettingsUpdaters } from '../features/settings/index.ts';
import { resetLayoutFromApi } from '../features/settings/index.ts';
import { api } from '../platform/api/index.ts';
import type { AppSettings } from '../platform/api/settings.ts';
import { commandResultError } from '../shared/errorMessages.ts';

interface ResetLayoutOptions {
  update: Pick<SettingsUpdaters, 'layout' | 'logging'>;
  confirm: (message: string, action: () => Promise<void>, options: object) => void;
  confirmMessage: string;
  confirmLabel: string;
  reportError: (error: unknown) => void;
  onReset?: () => void;
  hydrateLayout: (settings: AppSettings) => void;
}

export function useResetLayout(options: ResetLayoutOptions): () => void {
  return () => {
    options.confirm(
      options.confirmMessage,
      async () => {
        const result = await resetLayoutFromApi(api.app, {
          updateLayout: options.update.layout,
          updateLogging: options.update.logging,
          hydrateSectionResizeFromSettings: options.hydrateLayout,
        });
        if (!result.ok) {
          options.reportError(commandResultError(result));
          return;
        }
        // The renderer-side log stream (api.log) is a separate live
        // toggle from the `logEnabled` setting — normally kept in sync by
        // whatever changed the setting (see useWorkspaceLayout's toggleLog).
        // A layout reset changes `logEnabled` by writing straight to the
        // backend store, bypassing that pairing, so it has to stop the
        // stream itself here.
        api.log.setEnabled(!!result.settings?.logEnabled);
        options.onReset?.();
      },
      { confirmLabel: options.confirmLabel, danger: false },
    );
  };
}
