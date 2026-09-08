import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type { UpdaterStatus } from '../../platform/ipcContracts.ts';

const STARTUP_CHECK_DELAY_MS = 5000;
const PERIODIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdaterModel {
  status: UpdaterStatus | null;
  checkForUpdates: () => Promise<unknown>;
  installUpdate: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
}

export function useUpdater(
  autoCheck: boolean = true,
  hasActiveTransfers: boolean = false,
): UpdaterModel {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => api.updater.onStatus(setStatus), []);

  const checkForUpdates = useCallback(() => api.updater.check(), []);
  const installUpdate = useCallback(() => api.updater.install(), []);
  const downloadUpdate = useCallback(() => api.updater.download(), []);

  const autoCheckRef = useRef(autoCheck);
  useEffect(() => {
    autoCheckRef.current = autoCheck;
  }, [autoCheck]);

  const hasActiveTransfersRef = useRef(hasActiveTransfers);
  useEffect(() => {
    hasActiveTransfersRef.current = hasActiveTransfers;
  }, [hasActiveTransfers]);

  useEffect(() => {
    const checkWhenIdle = () => {
      // Deliberately unhandled: this is a background check the user never
      // asked for, and the updater reports its own outcome through the
      // 'error' status event that drives the update UI. Raising the app's
      // error banner for it would interrupt work over nothing.
      if (autoCheckRef.current && !hasActiveTransfersRef.current) void checkForUpdates();
    };
    const startupTimer = setTimeout(checkWhenIdle, STARTUP_CHECK_DELAY_MS);
    const periodicTimer = setInterval(checkWhenIdle, PERIODIC_CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(startupTimer);
      clearInterval(periodicTimer);
    };
  }, [checkForUpdates]);

  return { status, checkForUpdates, downloadUpdate, installUpdate };
}
