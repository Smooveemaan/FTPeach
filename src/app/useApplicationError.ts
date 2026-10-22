import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { describeUnknown } from '../platform/ipcContracts.ts';
import { setAsyncFailureSink } from '../shared/asyncFailure.ts';
import { friendlyError } from '../shared/errorMessages.ts';

export interface ApplicationErrorModel {
  errorMessage: string;
  setErrorMessage: Dispatch<SetStateAction<string>>;
  reportError: (raw: unknown) => void;
  /** Clears the banner if it still shows what `raw` reported. */
  withdrawError: (raw: unknown) => void;
  dismissError: () => void;
}

function bannerText(raw: unknown): string {
  const supported =
    typeof raw === 'string' || raw == null
      ? raw
      : typeof raw === 'object'
        ? (raw as { code?: string; message?: string })
        : describeUnknown(raw);
  return friendlyError(supported) ?? '';
}

export function useApplicationError(): ApplicationErrorModel {
  const [errorMessage, setErrorMessage] = useState('');
  const reportError = useCallback((raw: unknown) => setErrorMessage(bannerText(raw)), []);
  const withdrawError = useCallback((raw: unknown) => {
    const text = bannerText(raw);
    setErrorMessage((shown) => (shown === text ? '' : shown));
  }, []);
  const dismissError = useCallback(() => setErrorMessage(''), []);

  // Gives the async helpers in shared/asyncFailure.ts somewhere to write, so a
  // rejected IPC call deep in a hook still surfaces in this banner.
  useEffect(() => setAsyncFailureSink(reportError, withdrawError), [reportError, withdrawError]);

  return { errorMessage, setErrorMessage, reportError, withdrawError, dismissError };
}
