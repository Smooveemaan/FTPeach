import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from '../../../components/Modal.tsx';
import PasswordInput from '../../../components/PasswordInput.tsx';
import type { NoticeMessage } from '../../../hooks/useStatusNotice.ts';
import type { ManagedSite } from '../../../shared/siteContracts.ts';
import type { SettingsTransferOptions } from '../../../platform/api/settings.ts';
import { handler, reportRejection } from '../../../shared/asyncFailure.ts';
import type { ImportWarnings, SettingsTransferModel } from '../useSettingsTransfer.ts';

interface SettingsTransferDialogProps {
  mode: 'import' | 'export';
  transfer: SettingsTransferModel;
  /** The saved bookmarks: an export says how many passwords it would include. */
  sites: readonly ManagedSite[];
  /** What a finished export or import says, for the status line that started it. */
  onDone: (message: NoticeMessage) => void;
  onVaultUnlockRequired: (retry: () => void) => void;
  onClose: () => void;
  /** Which parts start ticked; the Site Manager ticks the manager it belongs to. All stay editable. */
  initialOptions: SettingsTransferOptions;
}

const TEXT = {
  import: {
    title: 'importSettingsDialog.title',
    confirmLabel: 'importSettingsDialog.confirmLabel',
    includeSettings: 'importSettingsDialog.includeSettings',
    includeBookmarks: 'importSettingsDialog.includeBookmarks',
    includeLocalPaths: 'importSettingsDialog.includeLocalPaths',
    passwordHint: 'importSettingsDialog.passwordHint',
  },
  export: {
    title: 'exportSettingsDialog.title',
    confirmLabel: 'exportSettingsDialog.confirmLabel',
    includeSettings: 'exportSettingsDialog.includeSettings',
    includeBookmarks: 'exportSettingsDialog.includeBookmarks',
    includeLocalPaths: 'exportSettingsDialog.includeLocalPaths',
    passwordHint: 'exportSettingsDialog.passwordHint',
  },
} as const;

const PARTS = ['includeSettings', 'includeBookmarks', 'includeLocalPaths'] as const;
/** The same minimum as the master password's; the backend checks it too. */
const MIN_EXPORT_PASSWORD_CHARS = 12;

type Step =
  | { name: 'options' }
  /** Export: bookmarks whose passwords cannot be opened here. */
  | { name: 'unreadable'; names: string[] }
  /** Import: the file has passwords; ask for the one it was exported with. */
  | { name: 'password' }
  /** Import: done, but some passwords stayed behind. */
  | { name: 'report'; warnings: ImportWarnings };

function NameList({ names }: { names: string[] }) {
  return (
    <ul className="settings-transfer-names">
      {names.map((name, index) => (
        <li key={`${index}:${name}`}>{name}</li>
      ))}
    </ul>
  );
}

/**
 * Chooses what a settings export or import covers, and carries it through:
 * the export's password for the saved passwords, the import's question for
 * the password a file was exported with.
 */
export default function SettingsTransferDialog({
  mode,
  transfer,
  sites,
  onDone,
  onVaultUnlockRequired,
  onClose,
  initialOptions,
}: SettingsTransferDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState(initialOptions);
  const [step, setStep] = useState<Step>({ name: 'options' });
  const [busy, setBusy] = useState(false);
  const [withSecrets, setWithSecrets] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [wrongPassword, setWrongPassword] = useState(false);
  // The backend keeps a previewed file until it is imported or let go.
  const [staged, setStaged] = useState(false);
  const text = TEXT[mode];

  const exportsSecrets = mode === 'export' && withSecrets && options.includeBookmarks;
  const savedSecrets = sites.reduce(
    (count, site) => count + Number(!!site.hasPassword) + Number(!!site.hasKeyPassphrase),
    0,
  );
  const passwordProblem = !exportsSecrets
    ? null
    : [...password].length < MIN_EXPORT_PASSWORD_CHARS
      ? 'exportSettingsDialog.passwordTooShort'
      : confirmation !== password
        ? 'exportSettingsDialog.passwordMismatch'
        : null;

  const close = () => {
    if (staged) transfer.discardImport();
    onClose();
  };

  /** With the saved passwords, a confirmation window asks first. */
  const runExport = async (skipUnreadable: boolean) => {
    setBusy(true);
    const outcome = await transfer
      .exportSettings(options, exportsSecrets ? { password, skipUnreadable } : undefined)
      .finally(() => setBusy(false));
    if (outcome && 'unreadable' in outcome) {
      setStep({ name: 'unreadable', names: outcome.unreadable });
      return;
    }
    if (outcome && 'vaultLocked' in outcome) {
      onVaultUnlockRequired(() => reportRejection(runExport(skipUnreadable)));
      return;
    }
    if (outcome) onDone(outcome.done);
    onClose();
  };

  /** `password` null imports the file without its passwords. */
  const apply = async (filePassword: string | null, closeOnFailure: boolean) => {
    setBusy(true);
    setWrongPassword(false);
    const outcome = await transfer.applyImport(options, filePassword).finally(() => setBusy(false));
    if (!outcome) {
      // Reported already. A file with passwords stays for another try.
      if (closeOnFailure) close();
      return;
    }
    if ('wrongPassword' in outcome) {
      setWrongPassword(true);
      return;
    }
    if ('vaultLocked' in outcome) {
      onVaultUnlockRequired(() => reportRejection(apply(filePassword, closeOnFailure)));
      return;
    }
    setStaged(false);
    onDone(outcome.done);
    if (outcome.warnings) setStep({ name: 'report', warnings: outcome.warnings });
    else onClose();
  };

  const startImport = async () => {
    setBusy(true);
    const preview = await transfer.previewImport(options).finally(() => setBusy(false));
    if (!preview) {
      onClose();
      return;
    }
    setStaged(true);
    if (preview.hasSecrets) setStep({ name: 'password' });
    else await apply(null, true);
  };

  const footer = (() => {
    switch (step.name) {
      case 'options':
        return (
          <ModalFooterActions
            onCancel={close}
            onConfirm={handler(() => (mode === 'export' ? runExport(false) : startImport()))}
            confirmLabel={t(text.confirmLabel)}
            cancelDisabled={busy}
            confirmDisabled={busy || PARTS.every((part) => !options[part]) || !!passwordProblem}
          />
        );
      case 'unreadable':
        return (
          <ModalFooterActions
            onCancel={close}
            onConfirm={handler(() => runExport(true))}
            confirmLabel={t('exportSettingsDialog.exportWithoutThem')}
            cancelDisabled={busy}
            confirmDisabled={busy}
          />
        );
      case 'password':
        return (
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handler(() => apply(null, false))}
              disabled={busy}
            >
              {t('importSettingsDialog.importWithoutPasswords')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handler(() => apply(password, false))}
              disabled={busy || !password}
            >
              {t('importSettingsDialog.importWithPasswords')}
            </button>
          </>
        );
      case 'report':
        return (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common.close')}
          </button>
        );
    }
  })();

  return (
    <Modal
      title={t(text.title)}
      onClose={close}
      closeDisabled={busy}
      className="modal-export-settings"
      footer={footer}
    >
      {step.name === 'options' && (
        <>
          <div className="settings-transfer-parts">
            {PARTS.map((part) => (
              <label key={part} className="secure-toggle settings-toggle">
                <input
                  type="checkbox"
                  checked={options[part]}
                  disabled={busy}
                  onChange={(e) =>
                    setOptions((current) => ({ ...current, [part]: e.target.checked }))
                  }
                />
                {t(text[part])}
              </label>
            ))}
          </div>
          {mode === 'import' ? (
            <p className="settings-hint settings-transfer-note">{t(text.passwordHint)}</p>
          ) : (
            <section className="settings-transfer-secrets">
              <label className="secure-toggle settings-toggle">
                <input
                  type="checkbox"
                  checked={exportsSecrets}
                  disabled={busy || !options.includeBookmarks}
                  onChange={(e) => setWithSecrets(e.target.checked)}
                />
                {t('exportSettingsDialog.includePasswords')}
              </label>
              {!exportsSecrets ? (
                <p className="settings-hint">{t(text.passwordHint)}</p>
              ) : (
                <>
                  <div className="settings-transfer-text">
                    <p className="settings-hint">
                      {t('exportSettingsDialog.passwordsCount', { count: savedSecrets })}
                    </p>
                    <p className="settings-hint settings-warning">
                      {t('exportSettingsDialog.passwordsWarning')}
                    </p>
                  </div>
                  <div className="vault-password-form">
                    <label className="settings-field">
                      <span>{t('exportSettingsDialog.exportPassword')}</span>
                      <PasswordInput
                        autoComplete="new-password"
                        value={password}
                        disabled={busy}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </label>
                    <label className="settings-field">
                      <span>{t('exportSettingsDialog.confirmExportPassword')}</span>
                      <PasswordInput
                        autoComplete="new-password"
                        value={confirmation}
                        disabled={busy}
                        onChange={(e) => setConfirmation(e.target.value)}
                      />
                    </label>
                  </div>
                  {passwordProblem && (password || confirmation) && (
                    <p className="settings-hint">{t(passwordProblem)}</p>
                  )}
                  <p className="settings-hint">{t('exportSettingsDialog.keysHint')}</p>
                </>
              )}
            </section>
          )}
        </>
      )}
      {step.name === 'unreadable' && (
        <>
          <p className="settings-hint settings-warning">{t('exportSettingsDialog.unreadable')}</p>
          <NameList names={step.names} />
        </>
      )}
      {step.name === 'password' && (
        <>
          <p className="settings-hint">{t('importSettingsDialog.filePasswordHint')}</p>
          <div className="vault-password-form">
            <label className="settings-field">
              <span>{t('importSettingsDialog.filePassword')}</span>
              <PasswordInput
                autoFocus
                autoComplete="off"
                className={wrongPassword ? 'is-invalid' : ''}
                value={password}
                disabled={busy}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setWrongPassword(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password && !busy)
                    reportRejection(apply(password, false));
                }}
              />
            </label>
          </div>
          {wrongPassword && (
            <p className="settings-hint vault-unlock-error" role="alert">
              {t('importSettingsDialog.wrongPassword')}
            </p>
          )}
        </>
      )}
      {step.name === 'report' && (
        <>
          {step.warnings.scopeMismatches.length > 0 && (
            <>
              <p className="settings-hint settings-warning">
                {t('importSettingsDialog.scopeMismatch')}
              </p>
              <NameList names={step.warnings.scopeMismatches} />
            </>
          )}
          {step.warnings.unmatched.length > 0 && (
            <>
              <p className="settings-hint">{t('importSettingsDialog.unmatched')}</p>
              <NameList names={step.warnings.unmatched} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
