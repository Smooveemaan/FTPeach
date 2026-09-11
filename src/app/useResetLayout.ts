import type { SettingsUpdaters } from '../features/settings/index.ts';
import { resetLayoutFromApi } from '../features/settings/index.ts';
import { api } from '../platform/api/index.ts';
import type { AppSettings } from '../platform/api/settings.ts';
import { commandResultError } from '../shared/errorMessages.ts';

interface ResetLayoutOptions {
  update: Pick<SettingsUpdaters, 'layout'>;
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
          hydrateSectionResizeFromSettings: options.hydrateLayout,
        });
        if (!result.ok) {
          options.reportError(commandResultError(result));
          return;
        }
        options.onReset?.();
      },
      { confirmLabel: options.confirmLabel, danger: false },
    );
  };
}
