import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import { setNativeInputValue } from '../../shared/nativeInput.ts';
import type { SiteFormSecrets } from './siteForm.ts';
import { api } from '../../platform/api/index.ts';

type SecretField = keyof SiteFormSecrets;

interface UseSiteSecretsOptions {
  editingId: string | null;
  revealFailedMessage: string;
  setError: Dispatch<SetStateAction<string>>;
}

export interface SiteSecretsController {
  keyPassphraseRef: RefObject<HTMLInputElement>;
  passwordRef: RefObject<HTMLInputElement>;
  readSecrets: () => SiteFormSecrets;
  resetSecrets: () => void;
  revealSavedSecret: (field: SecretField) => Promise<boolean>;
}

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';

export function useSiteSecrets({
  editingId,
  revealFailedMessage,
  setError,
}: UseSiteSecretsOptions): SiteSecretsController {
  const passwordRef = useRef<HTMLInputElement>(null);
  const keyPassphraseRef = useRef<HTMLInputElement>(null);

  const inputFor = useCallback(
    (field: SecretField) => (field === 'password' ? passwordRef.current : keyPassphraseRef.current),
    [],
  );

  const resetSecrets = useCallback(() => {
    setNativeInputValue(passwordRef.current, '');
    setNativeInputValue(keyPassphraseRef.current, '');
  }, []);

  useEffect(() => resetSecrets(), [editingId, resetSecrets]);

  useEffect(() => {
    const clearWhenHidden = () => {
      if (document.hidden) resetSecrets();
    };
    window.addEventListener('blur', resetSecrets);
    window.addEventListener('ftpeach:vault-locked', resetSecrets);
    document.addEventListener('visibilitychange', clearWhenHidden);
    return () => {
      resetSecrets();
      window.removeEventListener('blur', resetSecrets);
      window.removeEventListener('ftpeach:vault-locked', resetSecrets);
      document.removeEventListener('visibilitychange', clearWhenHidden);
    };
  }, [resetSecrets]);

  const readSecrets = useCallback(
    () => ({
      password: passwordRef.current?.value || '',
      keyPassphrase: keyPassphraseRef.current?.value || '',
    }),
    [],
  );

  const revealSavedSecret = useCallback(
    async (field: SecretField) => {
      if (!editingId || editingId === '__new__') return false;
      try {
        const result = await api.sites.revealSecret(editingId, field);
        if (!result.ok) {
          if (result.errorCode !== 'cancelled') {
            setError(friendlyError(commandResultError(result)) || revealFailedMessage);
          }
          return false;
        }
        setNativeInputValue(inputFor(field), result.value || '');
        return !!result.value;
      } catch (cause) {
        setError(causeMessage(cause) || revealFailedMessage);
        return false;
      }
    },
    [editingId, inputFor, revealFailedMessage, setError],
  );

  return {
    keyPassphraseRef,
    passwordRef,
    readSecrets,
    resetSecrets,
    revealSavedSecret,
  };
}
