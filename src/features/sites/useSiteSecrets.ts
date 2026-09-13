import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import { setNativeInputValue } from '../../shared/nativeInput.ts';
import type { SiteFormSecrets } from './siteForm.ts';
import { api } from '../../platform/api/index.ts';

type SecretField = keyof SiteFormSecrets;

interface UseSiteSecretsOptions {
  editingId: string | null;
  initialSecrets?: SiteFormSecrets | undefined;
  revealFailedMessage: string;
  setError: Dispatch<SetStateAction<string>>;
}

export interface SiteSecretsController {
  keyPassphraseRef: RefObject<HTMLInputElement>;
  passwordRef: RefObject<HTMLInputElement>;
  readSecrets: () => SiteFormSecrets;
  resetSecrets: () => void;
  revealSavedSecret: (field: SecretField) => Promise<boolean>;
  secretsChanged: () => boolean;
}

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';

export function useSiteSecrets({
  editingId,
  initialSecrets,
  revealFailedMessage,
  setError,
}: UseSiteSecretsOptions): SiteSecretsController {
  const passwordRef = useRef<HTMLInputElement>(null);
  const keyPassphraseRef = useRef<HTMLInputElement>(null);

  // What this hook itself last put into each input: a prefill, a reveal or a
  // reset. Anything else found there was typed by the user.
  const knownSecretsRef = useRef<SiteFormSecrets>({ password: '', keyPassphrase: '' });
  const setSecret = useCallback((field: SecretField, value: string) => {
    knownSecretsRef.current = { ...knownSecretsRef.current, [field]: value };
    setNativeInputValue(
      field === 'password' ? passwordRef.current : keyPassphraseRef.current,
      value,
    );
  }, []);

  const resetSecrets = useCallback(() => {
    setSecret('password', '');
    setSecret('keyPassphrase', '');
  }, [setSecret]);

  const initialPassword = initialSecrets?.password || '';
  const initialKeyPassphrase = initialSecrets?.keyPassphrase || '';
  useEffect(() => {
    resetSecrets();
    if (editingId === '__new__') {
      setSecret('password', initialPassword);
      setSecret('keyPassphrase', initialKeyPassphrase);
    }
  }, [editingId, initialPassword, initialKeyPassphrase, resetSecrets, setSecret]);

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

  const secretsChanged = useCallback(() => {
    const current = readSecrets();
    const known = knownSecretsRef.current;
    return current.password !== known.password || current.keyPassphrase !== known.keyPassphrase;
  }, [readSecrets]);

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
        setSecret(field, result.value || '');
        return !!result.value;
      } catch (cause) {
        setError(causeMessage(cause) || revealFailedMessage);
        return false;
      }
    },
    [editingId, revealFailedMessage, setError, setSecret],
  );

  return {
    keyPassphraseRef,
    passwordRef,
    readSecrets,
    resetSecrets,
    revealSavedSecret,
    secretsChanged,
  };
}
