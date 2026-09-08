import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../platform/api/index.ts';
import type { CommandResult } from '../../../platform/ipcContracts.ts';

export type VaultStatus = Awaited<ReturnType<typeof api.vault.status>>;
export type PasswordStrength = '' | 'tooShort' | 'strong' | 'acceptable';

const MIN_MASTER_PASSWORD_LENGTH = 12;

export const masterPasswordStrength = (password: string): PasswordStrength => {
  if (!password) return '';
  if ([...password].length < MIN_MASTER_PASSWORD_LENGTH) return 'tooShort';
  const characterGroups = [/[a-z]/, /[A-Z]/, /\d/, /[^\p{L}\p{N}]/u].filter((pattern) =>
    pattern.test(password),
  ).length;
  return [...password].length >= 16 && characterGroups >= 2 ? 'strong' : 'acceptable';
};

export interface VaultSettingsModel {
  vaultStatus: {
    configured: boolean;
    locked: boolean;
    systemUnlockAvailable: boolean;
    systemUnlockEnabled: boolean;
  } | null;
  vaultMessage: string;
  setVaultMessage: Dispatch<SetStateAction<string>>;
  vaultBusy: boolean;
  vaultUnlockInvalid: boolean;
  setVaultUnlockInvalid: Dispatch<SetStateAction<boolean>>;
  passwordStrength: PasswordStrength;
  setPasswordStrength: Dispatch<SetStateAction<PasswordStrength>>;
  changePasswordArmed: boolean;
  setChangePasswordArmed: Dispatch<SetStateAction<boolean>>;
  strongholdSetupArmed: boolean;
  setStrongholdSetupArmed: Dispatch<SetStateAction<boolean>>;
  masterPasswordRef: RefObject<HTMLInputElement>;
  masterPasswordConfirmRef: RefObject<HTMLInputElement>;
  oldMasterPasswordRef: RefObject<HTMLInputElement>;
  runVaultAction: (action: () => Promise<CommandResult>) => Promise<boolean>;
  setupVault: () => void | Promise<boolean>;
  unlockVault: () => Promise<boolean>;
  lockVault: () => Promise<boolean>;
  changeVaultPassword: () => Promise<void>;
  resetVault: () => Promise<void>;
  selectSystemProtection: () => Promise<boolean>;
  toggleSystemUnlock: () => Promise<boolean>;
}

export function useVaultSettings(): VaultSettingsModel {
  const { t } = useTranslation();
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultMessage, setVaultMessage] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultUnlockInvalid, setVaultUnlockInvalid] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength>('');
  const [changePasswordArmed, setChangePasswordArmed] = useState(false);
  const [strongholdSetupArmed, setStrongholdSetupArmed] = useState(false);
  const masterPasswordRef = useRef<HTMLInputElement>(null);
  const masterPasswordConfirmRef = useRef<HTMLInputElement>(null);
  const oldMasterPasswordRef = useRef<HTMLInputElement>(null);
  const vaultUnlockErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unavailableMessageRef = useRef(t('settings.security.unavailable'));
  unavailableMessageRef.current = t('settings.security.unavailable');

  const refreshVaultStatus = useCallback(() => api.vault.status().then(setVaultStatus), []);
  useEffect(() => {
    refreshVaultStatus().catch(() => setVaultMessage(unavailableMessageRef.current));
    // Wrapped in a block so the listener returns void: the rejection is
    // already handled by the .catch, only its type was leaking out.
    const refreshAfterAutoLock = () => {
      void refreshVaultStatus().catch(() => setVaultMessage(unavailableMessageRef.current));
    };
    window.addEventListener('ftpeach:vault-locked', refreshAfterAutoLock);
    return () => window.removeEventListener('ftpeach:vault-locked', refreshAfterAutoLock);
  }, [refreshVaultStatus]);

  useEffect(
    () => () => {
      if (vaultUnlockErrorTimerRef.current) clearTimeout(vaultUnlockErrorTimerRef.current);
    },
    [],
  );

  const showVaultUnlockError = (message = '') => {
    if (vaultUnlockErrorTimerRef.current) clearTimeout(vaultUnlockErrorTimerRef.current);
    setVaultMessage(message);
    setVaultUnlockInvalid(true);
    vaultUnlockErrorTimerRef.current = setTimeout(() => {
      setVaultMessage('');
      setVaultUnlockInvalid(false);
      vaultUnlockErrorTimerRef.current = null;
    }, 1800);
  };

  const runVaultAction = async (action: () => Promise<CommandResult>) => {
    setVaultMessage('');
    setVaultBusy(true);
    try {
      const result = await action();
      if (!result.ok) setVaultMessage(result.error || t('settings.security.failed'));
      else setVaultMessage('');
      for (const ref of [masterPasswordRef, masterPasswordConfirmRef, oldMasterPasswordRef]) {
        if (ref.current) ref.current.value = '';
      }
      setPasswordStrength('');
      await refreshVaultStatus();
      return result.ok;
    } catch (error) {
      setVaultMessage(
        (error instanceof Error ? error.message : String(error)) || t('settings.security.failed'),
      );
      return false;
    } finally {
      setVaultBusy(false);
    }
  };

  const setupVault = () => {
    const password = masterPasswordRef.current?.value || '';
    const confirmation = masterPasswordConfirmRef.current?.value || '';
    if ([...password].length < MIN_MASTER_PASSWORD_LENGTH)
      return setVaultMessage(t('settings.security.passwordTooShort'));
    if (password !== confirmation) return setVaultMessage(t('settings.security.passwordMismatch'));
    return runVaultAction(() => api.vault.setup(password));
  };

  const unlockVault = async () => {
    const password = masterPasswordRef.current?.value || '';
    if (!password) {
      showVaultUnlockError();
      masterPasswordRef.current?.focus();
      return false;
    }

    setVaultMessage('');
    setVaultUnlockInvalid(false);
    setVaultBusy(true);
    try {
      const result = await api.vault.unlock(password);
      if (!result.ok) {
        showVaultUnlockError(result.error || t('settings.security.failed'));
        return false;
      }
      if (masterPasswordRef.current) masterPasswordRef.current.value = '';
      await refreshVaultStatus();
      return true;
    } catch (error) {
      showVaultUnlockError(
        (error instanceof Error ? error.message : String(error)) || t('settings.security.failed'),
      );
      return false;
    } finally {
      setVaultBusy(false);
    }
  };

  const changeVaultPassword = async () => {
    const next = masterPasswordRef.current?.value || '';
    const confirmation = masterPasswordConfirmRef.current?.value || '';
    if ([...next].length < MIN_MASTER_PASSWORD_LENGTH)
      return setVaultMessage(t('settings.security.passwordTooShort'));
    if (next !== confirmation) return setVaultMessage(t('settings.security.passwordMismatch'));
    const succeeded = await runVaultAction(() =>
      api.vault.changePassword(oldMasterPasswordRef.current?.value || '', next),
    );
    if (succeeded) setChangePasswordArmed(false);
  };

  const resetVault = async () => {
    const succeeded = await runVaultAction(() => api.vault.reset());
    if (succeeded) {
      setStrongholdSetupArmed(false);
    }
  };

  const lockVault = () => runVaultAction(() => api.vault.lock());

  const selectSystemProtection = () => runVaultAction(() => api.vault.useSystemProtection(''));

  const toggleSystemUnlock = () =>
    runVaultAction(() =>
      vaultStatus?.systemUnlockEnabled
        ? api.vault.disableSystemUnlock()
        : api.vault.enableSystemUnlock(),
    );

  return {
    vaultStatus,
    vaultMessage,
    setVaultMessage,
    vaultBusy,
    vaultUnlockInvalid,
    setVaultUnlockInvalid,
    passwordStrength,
    setPasswordStrength,
    changePasswordArmed,
    setChangePasswordArmed,
    strongholdSetupArmed,
    setStrongholdSetupArmed,
    masterPasswordRef,
    masterPasswordConfirmRef,
    oldMasterPasswordRef,
    runVaultAction,
    setupVault,
    unlockVault,
    lockVault,
    changeVaultPassword,
    resetVault,
    selectSystemProtection,
    toggleSystemUnlock,
  };
}
