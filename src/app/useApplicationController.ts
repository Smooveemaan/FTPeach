import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../platform/api/index.ts';
import { describeUnknown } from '../platform/ipcContracts.ts';
import { setAsyncFailureSink } from '../shared/asyncFailure.ts';
import { friendlyError } from '../shared/errorMessages.ts';
import type { PaneStatus } from '../shared/paneContracts.ts';

export interface ApplicationErrorModel {
  errorMessage: string;
  setErrorMessage: Dispatch<SetStateAction<string>>;
  reportError: (raw: unknown) => void;
  dismissError: () => void;
}

export function useApplicationError(): ApplicationErrorModel {
  const [errorMessage, setErrorMessage] = useState('');
  const reportError = useCallback((raw: unknown) => {
    const supported =
      typeof raw === 'string' || raw == null
        ? raw
        : typeof raw === 'object'
          ? (raw as { code?: string; message?: string })
          : describeUnknown(raw);
    setErrorMessage(friendlyError(supported) ?? '');
  }, []);
  const dismissError = useCallback(() => setErrorMessage(''), []);

  // Gives the async helpers in shared/asyncFailure.ts somewhere to write, so a
  // rejected IPC call deep in a hook still surfaces in this banner.
  useEffect(() => setAsyncFailureSink(reportError), [reportError]);

  return { errorMessage, setErrorMessage, reportError, dismissError };
}

export function useVaultUnlockRecovery(
  setRetries: Dispatch<SetStateAction<Array<() => unknown>>>,
): (retry: () => unknown) => Promise<void> {
  return useCallback(
    async (retry: () => unknown) => {
      try {
        const status = await api.vault.status();
        if (status.systemUnlockAvailable && status.systemUnlockEnabled) {
          const result = await api.vault.unlockSystem();
          if (result.ok) {
            retry();
            return;
          }
        }
      } catch {
        // Platform credentials are an optional fast path. The queued retry
        // still allows recovery through the independent master password.
      }
      setRetries((previous) => [...previous, retry]);
    },
    [setRetries],
  );
}

export function connectionVisualState(
  status: PaneStatus,
  hasActiveTransfers: boolean,
  hasPausedTransfers: boolean,
) {
  if (status === 'connected') {
    if (hasActiveTransfers) return 'transferring';
    return hasPausedTransfers ? 'paused' : 'connected';
  }
  return status;
}

export function associatedApplication(path: string, associations: Record<string, string>) {
  const name = path.split('/').pop() || '';
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  return associations[extension] || null;
}
