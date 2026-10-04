import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../platform/api/index.ts';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import { commandResultError, friendlyError } from '../../../shared/errorMessages.ts';

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
    portable?: boolean;
  } | null;
  vaultMessage: string;
  setVaultMessage: Dispatch<SetStateAction<string>>;
  vaultBusy: boolean;
  /** Windows is making the Windows Hello key, which can take a while. */
  enablingSystemUnlock: boolean;
  unlockVaultWithSystem: () => Promise<boolean>;
  vaultUnlockInvalid: boolean;
  setVaultUnlockInvalid: Dispatch<SetStateAction<boolean>>;
  passwordStrength: PasswordStrength;
  setPasswordStrength: Dispatch<SetStateAction<PasswordStrength>>;
  changePasswordArmed: boolean;
  setChangePasswordArmed: Dispatch<SetStateAction<boolean>>;
  strongholdSetupArmed: boolean;
  setStrongholdSetupArmed: Dispatch<SetStateAction<boolean>>;
  masterPasswordRef: RefObject<HTMLInputElement | null>;
  masterPasswordConfirmRef: RefObject<HTMLInputElement | null>;
  oldMasterPasswordRef: RefObject<HTMLInputElement | null>;
  runVaultAction: (action: () => Promise<CommandResult>) => Promise<boolean>;
  setupVault: () => void | Promise<boolean>;
  unlockVault: () => Promise<boolean>;
  lockVault: () => Promise<boolean>;
  changeVaultPassword: () => Promise<void>;
  resetVault: () => Promise<void>;
  selectSystemProtection: () => Promise<boolean>;
  toggleSystemUnlock: () => Promise<boolean>;
}

/** `onVaultReset` runs after a reset went through: the saved secrets are gone with the vault. */
export function useVaultSettings(onVaultReset?: () => unknown): VaultSettingsModel {
  const { t } = useTranslation();
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultMessage, setVaultMessage] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultUnlockInvalid, setVaultUnlockInvalid] = useState(false);
  const [enablingSystemUnlock, setEnablingSystemUnlock] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength>('');
  const [changePasswordArmed, setChangePasswordArmed] = useState(false);
  const [strongholdSetupArmed, setStrongholdSetupArmed] = useState(false);
  const masterPasswordRef = useRef<HTMLInputElement>(null);
  const masterPasswordConfirmRef = useRef<HTMLInputElement>(null);
  const oldMasterPasswordRef = useRef<HTMLInputElement>(null);
  const unavailableMessageRef = useRef(t('settings.security.unavailable'));
  unavailableMessageRef.current = t('settings.security.unavailable');

  const refreshVaultStatus = useCallback(() => api.vault.status().then(setVaultStatus), []);
  useEffect(() => {
    refreshVaultStatus().catch(() => setVaultMessage(unavailableMessageRef.current));
    // Wrapped in a block so the listener returns void: the rejection is
    // already handled by the .catch, only its type was leaking out.
    const refreshAfterChange = () => {
      void refreshVaultStatus().catch(() => setVaultMessage(unavailableMessageRef.current));
    };
    const stopLocked = api.vault.onLocked(refreshAfterChange);
    // An unlock made elsewhere: the unlock prompt, or a confirmation window.
    const stopUnlocked = api.vault.onUnlocked(refreshAfterChange);
    return () => {
      stopLocked();
      stopUnlocked();
    };
  }, [refreshVaultStatus]);

  /** The error stays until the next attempt or an edit of the field clears it. */
  const showVaultError = (message: string) => setVaultMessage(message);

  const showVaultUnlockError = (message = '') => {
    showVaultError(message);
    setVaultUnlockInvalid(true);
  };

  const runVaultAction = async (action: () => Promise<CommandResult>) => {
    setVaultMessage('');
    setVaultBusy(true);
    try {
      const result = await action();
      // Declining the backend's confirmation is not a failure to report back:
      // the user cancelled it themselves a moment ago.
      if (!result.ok && result.errorCode !== 'cancelled')
        setVaultMessage(friendlyError(commandResultError(result)) || t('settings.security.failed'));
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
      return showVaultError(t('settings.security.passwordTooShort'));
    if (password !== confirmation) return showVaultError(t('settings.security.passwordMismatch'));
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
        showVaultUnlockError(
          friendlyError(commandResultError(result)) || t('settings.security.failed'),
        );
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

  const unlockVaultWithSystem = () => runVaultAction(() => api.vault.unlockSystem());

  const changeVaultPassword = async () => {
    const next = masterPasswordRef.current?.value || '';
    const confirmation = masterPasswordConfirmRef.current?.value || '';
    if ([...next].length < MIN_MASTER_PASSWORD_LENGTH)
      return showVaultError(t('settings.security.passwordTooShort'));
    if (next !== confirmation) return showVaultError(t('settings.security.passwordMismatch'));
    const succeeded = await runVaultAction(() =>
      api.vault.changePassword(oldMasterPasswordRef.current?.value || '', next),
    );
    if (succeeded) setChangePasswordArmed(false);
  };

  const resetVault = async () => {
    const succeeded = await runVaultAction(() => api.vault.reset());
    if (succeeded) {
      setStrongholdSetupArmed(false);
      onVaultReset?.();
    }
  };

  const lockVault = () => runVaultAction(() => api.vault.lock());

  const selectSystemProtection = async () => {
    const succeeded = await runVaultAction(() => api.vault.useSystemProtection());
    // Still armed from setting the vault up, it would keep the enhanced option selected.
    if (succeeded) setStrongholdSetupArmed(false);
    return succeeded;
  };

  const toggleSystemUnlock = async () => {
    if (vaultStatus?.systemUnlockEnabled)
      return runVaultAction(() => api.vault.disableSystemUnlock());
    // Windows makes a new Windows Hello key here, which can take a while.
    setEnablingSystemUnlock(true);
    try {
      return await runVaultAction(() => api.vault.enableSystemUnlock());
    } finally {
      setEnablingSystemUnlock(false);
    }
  };

  return {
    enablingSystemUnlock,
    unlockVaultWithSystem,
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
