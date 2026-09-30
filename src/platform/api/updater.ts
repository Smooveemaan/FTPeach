import { isUpdaterStatus, voidOutcome } from '../ipcContracts.ts';
import type { EventRegistrar, InvokeFn, UpdaterStatus } from '../ipcContracts.ts';

export function createUpdaterApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    status: async (): Promise<UpdaterStatus | null> => {
      const status = await invoke('updater_status');
      return isUpdaterStatus(status) ? status : null;
    },
    check: () => voidOutcome(invoke, 'updater_check'),
    download: () => voidOutcome(invoke, 'updater_download'),
    install: () => voidOutcome(invoke, 'updater_install'),
    onStatus: onEvent('updater:status', isUpdaterStatus),
  };
}
