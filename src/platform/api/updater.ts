import { isUpdaterStatus } from '../ipcContracts.ts';
import type { EventRegistrar, InvokeFn, UpdaterStatus } from '../ipcContracts.ts';

export function createUpdaterApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    status: async (): Promise<UpdaterStatus | null> => {
      const status = await invoke('updater_status');
      return isUpdaterStatus(status) ? status : null;
    },
    check: () => invoke('updater_check'),
    download: () => invoke('updater_download'),
    install: () => invoke('updater_install'),
    onStatus: onEvent('updater:status', isUpdaterStatus),
  };
}
