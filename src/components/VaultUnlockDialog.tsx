import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from './Modal.tsx';
import Icon from './Icon.tsx';
import PasswordInput from './PasswordInput.tsx';
import { reportRejection, handler } from '../shared/asyncFailure.ts';

interface VaultUnlockDialogProps {
  onUnlocked: () => void;
  onClose: () => void;
  /**
   * The vault calls this dialog makes, injected rather than read off the
   * global: a shared component has no business knowing how IPC is reached.
   */
  vaultApi: Pick<Window['api']['vault'], 'status' | 'unlock' | 'unlockSystem'>;
}

export default function VaultUnlockDialog({
  onUnlocked,
  onClose,
  vaultApi,
}: VaultUnlockDialogProps) {
  const { t } = useTranslation();
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState('');
  const [passwordInvalid, setPasswordInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [systemUnlock, setSystemUnlock] = useState(false);

  useEffect(() => {
    let active = true;
    vaultApi
      .status()
      .then((status) => {
        if (active) setSystemUnlock(status.systemUnlockAvailable && status.systemUnlockEnabled);
      })
      .catch(reportAsyncFailure);
    return () => {
      active = false;
    };
  }, [vaultApi]);

  useEffect(
    () => () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    },
    [],
  );

  const clearPasswordError = () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = null;
    setError('');
    setPasswordInvalid(false);
  };

  const showPasswordError = (message = '') => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setError(message);
    setPasswordInvalid(true);
    errorTimerRef.current = setTimeout(() => {
      setError('');
      setPasswordInvalid(false);
      errorTimerRef.current = null;
    }, 1800);
  };

  const unlock = async () => {
    const password = passwordRef.current?.value || '';
    if (!password) {
      showPasswordError();
      passwordRef.current?.focus();
      return;
    }

    setBusy(true);
    clearPasswordError();
    try {
      const result = await vaultApi.unlock(password);
      if (!result.ok) {
        showPasswordError(result.error || t('settings.security.failed'));
        return;
      }
      if (passwordRef.current) passwordRef.current.value = '';
      onUnlocked();
    } catch (unlockError) {
      showPasswordError(
        (unlockError instanceof Error ? unlockError.message : String(unlockError)) ||
          t('settings.security.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const unlockWithSystem = async () => {
    setBusy(true);
    clearPasswordError();
    try {
      const result = await vaultApi.unlockSystem();
      if (!result.ok) setError(result.error || t('settings.security.failed'));
      else onUnlocked();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('settings.security.unlockRequired')}
      onClose={onClose}
      closeDisabled={busy}
      className="modal-vault-unlock"
      footer={
        <ModalFooterActions
          onCancel={onClose}
          onConfirm={handler(unlock)}
          confirmLabel={busy ? t('settings.security.unlocking') : t('settings.security.unlock')}
          cancelDisabled={busy}
          confirmDisabled={busy}
        />
      }
    >
      <p className="settings-hint">{t('settings.security.unlockRequiredHint')}</p>
      <div className="vault-unlock-row">
        {systemUnlock && (
          <button
            type="button"
            className="btn btn-icon vault-system-unlock"
            onClick={handler(unlockWithSystem)}
            disabled={busy}
            aria-label={t('settings.security.unlockWithSystem')}
            data-tooltip={t('settings.security.unlockWithSystem')}
          >
            <Icon name="fingerprintPattern" size={16} />
          </button>
        )}
        <label className="settings-field">
          <span>{t('settings.security.masterPassword')}</span>
          <PasswordInput
            ref={passwordRef}
            className={passwordInvalid ? 'is-invalid' : ''}
            autoComplete="current-password"
            autoFocus
            onInput={() => {
              if (passwordInvalid) clearPasswordError();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) reportRejection(unlock());
            }}
          />
        </label>
      </div>
      {error && (
        <p
          className={`settings-hint settings-warning${passwordInvalid ? ' settings-error-fade' : ''}`}
          role={passwordInvalid ? 'alert' : 'status'}
          aria-live={passwordInvalid ? 'assertive' : 'polite'}
        >
          {error}
        </p>
      )}
    </Modal>
  );
}
