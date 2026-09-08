import { useUpdater } from '../features/updater/index.ts';
import type { UpdaterModel } from '../features/updater/index.ts';
import type { UpdaterStatus } from '../platform/ipcContracts.ts';

export interface UpdateBannerModel extends UpdaterModel {
  banner: Extract<UpdaterStatus, { version: string }> | null;
}

export function useUpdateBanner(
  autoCheckUpdates: boolean,
  hasActiveTransfers: boolean,
): UpdateBannerModel {
  const updater = useUpdater(autoCheckUpdates, hasActiveTransfers);
  const banner = updater.status && 'version' in updater.status ? updater.status : null;
  return { ...updater, banner };
}
