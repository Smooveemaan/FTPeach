import { commandResultError } from '../shared/errorMessages.ts';
import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { api } from './api/index.ts';

// Merge rapid UI changes and serialize writes so an older response cannot
// persist after a newer revision. Commands never run inside React updaters.
export function createSettingPersister({
  write = (patch) => api.settings.set(patch),
  report = reportAsyncFailure,
  schedule = (callback) => setTimeout(callback, 75),
  cancel = (timer) => clearTimeout(timer),
}: {
  write?: (
    patch: Record<string, unknown>,
  ) => Promise<{ ok?: boolean | undefined; error?: unknown; errorCode?: unknown }>;
  report?: (error: unknown) => void;
  schedule?: (callback: () => void) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}): (patch: Record<string, unknown>) => void {
  let pending: Record<string, unknown> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let revision = 0;

  async function flush(): Promise<void> {
    timer = undefined;
    if (writing || Object.keys(pending).length === 0) return;
    writing = true;
    const patch = pending;
    const sentRevision = revision;
    pending = {};
    try {
      const result = await write(patch);
      if (result.ok === false)
        report(
          commandResultError({
            error: typeof result.error === 'string' ? result.error : undefined,
            errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
          }),
        );
    } catch (error) {
      report(error);
    } finally {
      writing = false;
      if (revision !== sentRevision) void flush();
    }
  }

  return function persistSetting(patch: Record<string, unknown>): void {
    pending = { ...pending, ...patch };
    revision += 1;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      void flush();
    });
  };
}

export const persistSetting = createSettingPersister();
