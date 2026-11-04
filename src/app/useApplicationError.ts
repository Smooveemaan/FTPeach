import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeUnknown } from '../platform/ipcContracts.ts';
import { setAsyncFailureSink } from '../shared/asyncFailure.ts';
import { friendlyError } from '../shared/errorMessages.ts';

export interface ApplicationErrorMessage {
  id: number;
  text: string;
  raw: unknown;
  owner?: string | undefined;
}

export interface ApplicationErrorModel {
  errorMessage: string;
  errorMessages: ApplicationErrorMessage[];
  setErrorMessage: Dispatch<SetStateAction<string>>;
  reportError: (raw: unknown, owner?: string) => void;
  /** Clears only the message reported by this operation or raw error. */
  withdrawError: (raw: unknown, owner?: string) => void;
  dismissError: (id?: number) => void;
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

const MAX_ERROR_MESSAGES = 3;
const MANUAL_ERROR_OWNER = 'manual';

export function useApplicationError(): ApplicationErrorModel {
  const [errorMessages, setErrorMessages] = useState<ApplicationErrorMessage[]>([]);
  const nextIdRef = useRef(0);
  const nextId = useCallback(() => ++nextIdRef.current, []);
  const reportError = useCallback(
    (raw: unknown, owner?: string) => {
      const text = bannerText(raw);
      setErrorMessages((current) => {
        if (!text)
          return owner === undefined ? current : current.filter((item) => item.owner !== owner);
        const existing =
          owner === undefined ? undefined : current.find((item) => item.owner === owner);
        const message = { id: existing?.id ?? nextId(), text, raw, owner };
        return [message, ...current.filter((item) => item.id !== message.id)].slice(
          0,
          MAX_ERROR_MESSAGES,
        );
      });
    },
    [nextId],
  );
  const withdrawError = useCallback((raw: unknown, owner?: string) => {
    setErrorMessages((current) =>
      current.filter((item) => (owner === undefined ? item.raw !== raw : item.owner !== owner)),
    );
  }, []);
  const dismissError = useCallback((id?: number) => {
    setErrorMessages((current) =>
      id === undefined ? [] : current.filter((item) => item.id !== id),
    );
  }, []);
  const setErrorMessage = useCallback<Dispatch<SetStateAction<string>>>(
    (update) => {
      setErrorMessages((current) => {
        const previous = current.find((item) => item.owner === MANUAL_ERROR_OWNER)?.text ?? '';
        const text = typeof update === 'function' ? update(previous) : update;
        if (!text) return current.filter((item) => item.owner !== MANUAL_ERROR_OWNER);
        const existing = current.find((item) => item.owner === MANUAL_ERROR_OWNER);
        const message = {
          id: existing?.id ?? nextId(),
          text,
          raw: text,
          owner: MANUAL_ERROR_OWNER,
        };
        return [message, ...current.filter((item) => item.id !== message.id)].slice(
          0,
          MAX_ERROR_MESSAGES,
        );
      });
    },
    [nextId],
  );

  useEffect(() => setAsyncFailureSink(reportError, withdrawError), [reportError, withdrawError]);

  return {
    errorMessage: errorMessages[0]?.text ?? '',
    errorMessages,
    setErrorMessage,
    reportError,
    withdrawError,
    dismissError,
  };
}
