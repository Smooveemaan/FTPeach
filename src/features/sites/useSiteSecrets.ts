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
  keyPassphraseRef: RefObject<HTMLInputElement | null>;
  passwordRef: RefObject<HTMLInputElement | null>;
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

  // A reveal in flight belongs to the site, field and input contents it was
  // asked for. Anything that clears the fields -- another site, a reset, the
  // window losing focus or hiding, the vault locking, unmounting -- moves the
  // generation on, and a later answer is dropped instead of filling an input
  // it no longer belongs to.
  const generationRef = useRef(0);
  // The backend asks before revealing in a window of its own, which takes focus
  // from this one. That blur is the reveal's own doing and must not drop it.
  const revealingRef = useRef(0);

  const resetSecrets = useCallback(() => {
    generationRef.current += 1;
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
    const clearOnBlur = () => {
      if (!revealingRef.current) resetSecrets();
    };
    window.addEventListener('blur', clearOnBlur);
    const stopListening = api.vault.onLocked(resetSecrets);
    document.addEventListener('visibilitychange', clearWhenHidden);
    return () => {
      resetSecrets();
      window.removeEventListener('blur', clearOnBlur);
      stopListening();
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
      const input = () => (field === 'password' ? passwordRef.current : keyPassphraseRef.current);
      const generation = generationRef.current;
      const asked = input()?.value ?? '';
      // The user typed a password of their own while the answer was on its way.
      const superseded = () =>
        generationRef.current !== generation || (input()?.value ?? '') !== asked;
      revealingRef.current += 1;
      try {
        const result = await api.sites.revealSecret(editingId, field).finally(() => {
          revealingRef.current -= 1;
        });
        if (superseded()) return false;
        if (!result.ok) {
          if (result.errorCode !== 'cancelled') {
            setError(friendlyError(commandResultError(result)) || revealFailedMessage);
          }
          return false;
        }
        setSecret(field, result.value || '');
        return !!result.value;
      } catch (cause) {
        if (superseded()) return false;
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
