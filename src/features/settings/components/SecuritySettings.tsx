import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import PasswordInput from '../../../components/PasswordInput.tsx';
import { masterPasswordStrength, type useVaultSettings } from '../hooks/useVaultSettings.ts';
import NumberStepper from './NumberStepper.tsx';
import { reportRejection, handler } from '../../../shared/asyncFailure.ts';

interface SecuritySettingsProps {
  vault: ReturnType<typeof useVaultSettings>;
  vaultAutoLockValue: string;
  setVaultAutoLockValue: (value: string) => void;
  showSecurityConfirmationsValue: boolean;
  setShowSecurityConfirmationsValue: (value: boolean) => void;
}

export default function SecuritySettings({
  vault,
  vaultAutoLockValue,
  setVaultAutoLockValue,
  showSecurityConfirmationsValue,
  setShowSecurityConfirmationsValue,
}: SecuritySettingsProps) {
  const { t } = useTranslation();
  const {
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
    setupVault,
    unlockVault,
    lockVault,
    changeVaultPassword,
    resetVault,
    selectSystemProtection,
    toggleSystemUnlock,
  } = vault;

  return (
    <section className="settings-security settings-option-list">
      <div className="settings-option-group">
        <div className="security-mode-list">
          <label className="security-mode-option">
            <input
              type="radio"
              name="password-protection-mode"
              checked={vaultStatus?.configured === false && !strongholdSetupArmed}
              disabled={
                !vaultStatus || vaultBusy || (!!vaultStatus.configured && vaultStatus.locked)
              }
              onChange={() => {
                if (vaultStatus?.configured && !vaultStatus.locked) {
                  reportRejection(selectSystemProtection());
                } else if (vaultStatus?.configured === false) {
                  setStrongholdSetupArmed(false);
                  setVaultMessage('');
                }
              }}
            />
            <span>
              <strong>{t('settings.security.systemMode')}</strong>
              <small>{t('settings.security.systemModeHint')}</small>
            </span>
          </label>
          <label className="security-mode-option">
            <input
              type="radio"
              name="password-protection-mode"
              checked={!!vaultStatus?.configured || strongholdSetupArmed}
              disabled={!vaultStatus || vaultBusy}
              onChange={() => {
                if (vaultStatus?.configured === false) {
                  setStrongholdSetupArmed(true);
                  setVaultMessage('');
                }
              }}
            />
            <span>
              <strong>{t('settings.security.strongholdMode')}</strong>
              <small>{t('settings.security.strongholdModeHint')}</small>
            </span>
          </label>
        </div>
        {(!vaultStatus || vaultStatus.configured) && (
          <p className="settings-hint">
            {!vaultStatus
              ? t('settings.security.loading')
              : vaultStatus.locked
                ? t('settings.security.configuredLocked')
                : t('settings.security.configuredUnlocked')}
          </p>
        )}
      </div>
      {!vaultStatus ? null : !vaultStatus.configured &&
        !strongholdSetupArmed ? null : !vaultStatus.configured ? (
        <div className="settings-option-group">
          <p className="settings-hint settings-warning">{t('settings.security.noRecovery')}</p>
          <div className="vault-password-form">
            <label className="settings-field">
              <span>{t('settings.security.masterPassword')}</span>
              <PasswordInput
                ref={masterPasswordRef}
                autoComplete="new-password"
                onInput={(event) =>
                  setPasswordStrength(masterPasswordStrength(event.currentTarget.value))
                }
              />
            </label>
            <label className="settings-field">
              <span>{t('settings.security.confirmPassword')}</span>
              <PasswordInput ref={masterPasswordConfirmRef} autoComplete="new-password" />
            </label>
          </div>
          {passwordStrength && (
            <p className={`settings-hint password-strength ${passwordStrength}`}>
              {t(`settings.security.strength.${passwordStrength}`)}
            </p>
          )}
          <div className="settings-inline-actions vault-password-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handler(setupVault)}
              disabled={vaultBusy}
            >
              {vaultBusy ? t('settings.security.settingUp') : t('settings.security.setup')}
            </button>
          </div>
          {vaultMessage && (
            <p className="settings-hint" role="status" aria-live="polite">
              {vaultMessage}
            </p>
          )}
        </div>
      ) : vaultStatus.locked ? (
        <div className="settings-option-group">
          <div className="vault-unlock-row">
            <button
              type="button"
              className="btn btn-icon vault-lock-toggle is-locked"
              disabled={vaultBusy}
              onClick={handler(unlockVault)}
              aria-label={
                vaultBusy ? t('settings.security.unlocking') : t('settings.security.unlock')
              }
              data-tooltip={
                vaultBusy ? t('settings.security.unlocking') : t('settings.security.unlock')
              }
            >
              <Icon name="lock" size={16} />
            </button>
            <label className="settings-field">
              <span>{t('settings.security.masterPassword')}</span>
              <PasswordInput
                ref={masterPasswordRef}
                className={vaultUnlockInvalid ? 'is-invalid' : ''}
                autoComplete="current-password"
                autoFocus
                onInput={() => {
                  if (vaultUnlockInvalid) {
                    setVaultUnlockInvalid(false);
                    setVaultMessage('');
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !vaultBusy) reportRejection(unlockVault());
                }}
              />
            </label>
          </div>
          {vaultMessage && (
            <p
              className="settings-hint settings-warning settings-error-fade"
              role="alert"
              aria-live="assertive"
            >
              {vaultMessage}
            </p>
          )}
        </div>
      ) : (
        <div className="settings-option-group">
          {!changePasswordArmed ? (
            <div className="settings-inline-actions">
              <button
                type="button"
                className="btn btn-icon vault-lock-toggle is-unlocked"
                onClick={handler(lockVault)}
                aria-label={t('settings.security.lockNow')}
                data-tooltip={t('settings.security.lockNow')}
              >
                <Icon name="lockOpen" size={16} />
              </button>
              <button type="button" className="btn" onClick={() => setChangePasswordArmed(true)}>
                {t('settings.security.changePassword')}
              </button>
            </div>
          ) : (
            <>
              <div className="vault-password-form">
                <label className="settings-field">
                  <span>{t('settings.security.oldPassword')}</span>
                  <PasswordInput
                    ref={oldMasterPasswordRef}
                    autoComplete="current-password"
                    autoFocus
                  />
                </label>
                <label className="settings-field">
                  <span>{t('settings.security.newPassword')}</span>
                  <PasswordInput
                    ref={masterPasswordRef}
                    autoComplete="new-password"
                    onInput={(event) =>
                      setPasswordStrength(masterPasswordStrength(event.currentTarget.value))
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>{t('settings.security.confirmPassword')}</span>
                  <PasswordInput ref={masterPasswordConfirmRef} autoComplete="new-password" />
                </label>
              </div>
              {passwordStrength && (
                <p className={`settings-hint password-strength ${passwordStrength}`}>
                  {t(`settings.security.strength.${passwordStrength}`)}
                </p>
              )}
              <div className="settings-inline-actions vault-password-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={vaultBusy}
                  onClick={handler(changeVaultPassword)}
                >
                  {t('settings.security.change')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={vaultBusy}
                  onClick={() => {
                    setChangePasswordArmed(false);
                    setPasswordStrength('');
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </>
          )}
          {vaultMessage && (
            <p className="settings-hint" role="status">
              {vaultMessage}
            </p>
          )}
        </div>
      )}
      {vaultStatus?.configured && (
        <div className="settings-option-group">
          <label className="secure-toggle settings-toggle">
            <input
              type="checkbox"
              checked={!!vaultStatus.systemUnlockEnabled}
              disabled={
                vaultBusy ||
                (!vaultStatus.systemUnlockEnabled &&
                  (vaultStatus.locked || !vaultStatus.systemUnlockAvailable))
              }
              onChange={handler(toggleSystemUnlock)}
            />
            {t('settings.security.systemUnlock')}
          </label>
          <p className="settings-hint">
            {vaultStatus.systemUnlockAvailable
              ? t('settings.security.systemUnlockHint')
              : t('settings.security.systemUnavailable')}
          </p>
        </div>
      )}
      {vaultStatus?.configured && (
        <div className="settings-option-group">
          <label className="settings-field">
            <span>{t('settings.security.autoLock')}</span>
            <NumberStepper
              min={0}
              max={1440}
              placeholder={t('settings.security.autoLockDisabled')}
              value={vaultAutoLockValue}
              onChange={setVaultAutoLockValue}
            />
          </label>
          <p className="settings-hint">{t('settings.security.autoLockHint')}</p>
        </div>
      )}
      {vaultStatus?.configured && (
        <div className="settings-danger-zone settings-option-group">
          <button
            type="button"
            className="btn btn-danger btn-danger-reveal"
            onClick={handler(resetVault)}
            disabled={vaultBusy}
          >
            {t('settings.security.reset')}
          </button>
          <p className="settings-hint">{t('settings.security.resetHint')}</p>
        </div>
      )}
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={showSecurityConfirmationsValue}
            onChange={(event) => setShowSecurityConfirmationsValue(event.target.checked)}
          />
          <span>{t('settings.security.showConfirmations')}</span>
        </label>
        <p className="settings-hint">{t('settings.security.showConfirmationsHint')}</p>
      </div>
    </section>
  );
}
