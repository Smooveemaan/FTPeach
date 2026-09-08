import { isUpdaterStatus } from '../ipcContracts.ts';
import type { EventRegistrar, InvokeFn } from '../ipcContracts.ts';

export function createUpdaterApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    check: () => invoke('updater_check'),
    download: () => invoke('updater_download'),
    install: () => invoke('updater_install'),
    onStatus: onEvent('updater:status', isUpdaterStatus),
  };
}
