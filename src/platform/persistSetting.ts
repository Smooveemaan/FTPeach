import { commandResultError } from '../shared/errorMessages.ts';
import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { api } from './api/index.ts';
import { registerShutdownWriter } from './shutdownPersistence.ts';

interface SettingPersister {
  (patch: Record<string, unknown>): void;
  flush: () => Promise<void>;
  status: () => { pending: boolean; writing: boolean };
}

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
} = {}): SettingPersister {
  let pending: Record<string, unknown> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let revision = 0;

  async function drain(): Promise<void> {
    while (Object.keys(pending).length > 0) {
      const patch = pending;
      const sentRevision = revision;
      pending = {};
      try {
        const result = await write(patch);
        if (result.ok === false) {
          const failure = commandResultError({
            error: typeof result.error === 'string' ? result.error : undefined,
            errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
          });
          throw typeof failure === 'object' && failure !== null
            ? Object.assign(new Error(failure.message), failure)
            : new Error(failure ?? 'Settings could not be saved');
        }
      } catch (error) {
        pending = { ...patch, ...pending };
        report(error);
        // A failing disk must not cause an endless automatic retry loop.
        if (revision === sentRevision) throw error;
      }
    }
  }

  function flush(): Promise<void> {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    writing ??= drain().finally(() => {
      writing = undefined;
    });
    return writing;
  }

  return Object.assign(
    function persistSetting(patch: Record<string, unknown>): void {
      pending = { ...pending, ...patch };
      revision += 1;
      if (timer !== undefined) cancel(timer);
      timer = schedule(() => {
        void flush().catch(() => {});
      });
    },
    {
      flush,
      status: () => ({ pending: Object.keys(pending).length > 0, writing: writing !== undefined }),
    },
  );
}

export const persistSetting = createSettingPersister();
registerShutdownWriter('settings', persistSetting.flush);
