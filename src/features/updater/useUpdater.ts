import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type { UpdaterStatus } from '../../platform/ipcContracts.ts';

// The startup check belongs to the backend: it begins with the process, so an
// update can be on the status bar as soon as the window is. This hook only
// repeats the check for sessions that stay open for days.
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

  useEffect(() => {
    let subscribed = true;
    const unsubscribe = api.updater.onStatus(setStatus);
    // The backend has usually reported before this subscription existed. An
    // event that lands while the snapshot is in flight is newer, so it wins.
    void api.updater.status().then((current) => {
      if (subscribed && current) setStatus((previous) => previous ?? current);
    });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, []);

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
    const periodicTimer = setInterval(() => {
      // Deliberately unhandled: this is a background check the user never
      // asked for, and the updater reports its own outcome through the
      // 'error' status event that drives the update UI. Raising the app's
      // error banner for it would interrupt work over nothing.
      if (autoCheckRef.current && !hasActiveTransfersRef.current) void checkForUpdates();
    }, PERIODIC_CHECK_INTERVAL_MS);
    return () => clearInterval(periodicTimer);
  }, [checkForUpdates]);

  return { status, checkForUpdates, downloadUpdate, installUpdate };
}
