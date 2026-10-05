import { invoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, matchSupportedLanguage } from '../i18n/index.ts';
import { useTruncated } from '../hooks/useTruncated.ts';
import Icon from '../components/Icon.tsx';
import { useTooltip } from '../hooks/useTooltip.ts';
import '../styles/security-confirmation.css';

type ConfirmationKind =
  | 'revealSiteSecret'
  | 'revealProxyPassword'
  | 'vaultReset'
  | 'executeLocalFile'
  | 'executeRemoteFile'
  | 'openWithApplication'
  | 'weakenSecuritySettings'
  | 'useSystemProtection'
  | 'transferSecret'
  | 'trustHostKey';

const OPERATION_TRANSLATION_KEYS: Record<ConfirmationKind, string> = {
  revealSiteSecret: 'securityConfirmation.operations.revealSiteSecret',
  revealProxyPassword: 'securityConfirmation.operations.revealProxyPassword',
  vaultReset: 'securityConfirmation.operations.vaultReset',
  executeLocalFile: 'securityConfirmation.operations.executeLocalFile',
  executeRemoteFile: 'securityConfirmation.operations.executeRemoteFile',
  openWithApplication: 'securityConfirmation.operations.openWithApplication',
  weakenSecuritySettings: 'securityConfirmation.operations.weakenSecuritySettings',
  useSystemProtection: 'securityConfirmation.operations.useSystemProtection',
  transferSecret: 'securityConfirmation.operations.transferSecret',
  // The two host-key decisions read differently enough to deserve their own
  // wording, so the key is chosen from the prompt rather than the kind.
  trustHostKey: 'securityConfirmation.operations.trustHostKeyFirst',
};

interface SecretTransfer {
  from: string;
  to: string;
  lessSecure: boolean;
}

interface SecurityChanges {
  showSecurityConfirmations?: boolean | null;
  vaultAutoLockMinutes?: number | null;
  strictHostKeyCheck?: boolean | null;
}

interface HostKeyFingerprints {
  /** The pinned fingerprint, absent on a first connection. */
  expected?: string | null;
  actual: string;
}

interface ConfirmationPrompt {
  kind: ConfirmationKind;
  locale: string;
  target?: string | null;
  localName?: string | null;
  application?: string | null;
  securityChanges?: SecurityChanges | null;
  secretTransfer?: SecretTransfer | null;
  hostKey?: HostKeyFingerprints | null;
  confirmationPhrase?: string | null;
  requiresReauthentication: boolean;
  /** Windows Hello can stand in for the master password. */
  systemUnlock?: boolean;
}

interface SecurityConfirmationProps {
  requestId: string;
}

export default function SecurityConfirmation({ requestId }: SecurityConfirmationProps) {
  const { t, i18n } = useTranslation();
  const [prompt, setPrompt] = useState<ConfirmationPrompt | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [masterPassword, setMasterPassword] = useState('');
  const [authenticationError, setAuthenticationError] = useState(false);
  // Windows Hello is asked first; the master password field appears when it
  // was cancelled or failed.
  const [helloFailed, setHelloFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const helloAskedRef = useRef(false);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void invoke<ConfirmationPrompt>('plugin:sensitive|sensitive_confirmation_prompt', {
      requestId,
    })
      .then(async (nextPrompt) => {
        const locale = matchSupportedLanguage(nextPrompt.locale) ?? 'en';
        await changeLanguage(locale);
        setPrompt(nextPrompt);
      })
      .catch(() => getCurrentWindow().close());
  }, [i18n, requestId]);

  const translationKey = prompt
    ? prompt.kind === 'trustHostKey' && prompt.hostKey?.expected
      ? 'securityConfirmation.operations.trustHostKeyChanged'
      : OPERATION_TRANSLATION_KEYS[prompt.kind]
    : null;
  const title = t('securityConfirmation.title');
  const titleText = prompt ? title : 'FTPeach';
  const [titleRef, titleTruncated] = useTruncated<HTMLSpanElement>([titleText]);
  const cancelLabel = t('common.cancel');
  const approveLabel = translationKey
    ? t(`${translationKey}.approve`, { defaultValue: t('securityConfirmation.allow') })
    : t('securityConfirmation.allow');

  useLayoutEffect(() => {
    if (!prompt || !contentRef.current) return;
    // Windows Hello alone, before this window shows: it appears only when
    // Hello does not confirm, with the master password.
    if (askHelloAtOnce && !helloAskedRef.current) {
      helloAskedRef.current = true;
      void respond(true);
      return;
    }
    let cancelled = false;
    const resizeToContent = async () => {
      const content = contentRef.current;
      if (!content || cancelled) return;
      const titlebar = content.previousElementSibling as HTMLElement | null;
      const actions = content.nextElementSibling as HTMLElement | null;
      const message = content.querySelector('p');
      // As wide as the unlock dialog, unless the message needs more.
      const availableWidth = Math.max(440, window.screen.availWidth - 48);
      const messageWidth = message?.scrollWidth ?? 0;
      const width = Math.ceil(Math.min(720, availableWidth, Math.max(440, messageWidth + 28)));
      await getCurrentWindow().setSize(new LogicalSize(width, window.innerHeight));
      // Set by this effect's cleanup, which the compiler does not model.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) return;
      requestAnimationFrame(() => {
        void (async () => {
          const currentContent = contentRef.current;
          if (!currentContent || cancelled) return;
          const height = Math.ceil(
            (titlebar?.offsetHeight ?? 0) +
              currentContent.scrollHeight +
              (actions?.offsetHeight ?? 0),
          );
          await getCurrentWindow().setSize(new LogicalSize(width, height));
          // Set by this effect's cleanup, which the compiler does not model.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (cancelled) return;
          await invoke('plugin:sensitive|sensitive_confirmation_ready', { requestId }).catch(() =>
            getCurrentWindow().close(),
          );
        })();
      });
    };
    void resizeToContent();
    return () => {
      cancelled = true;
    };
    // `respond` and `askHelloAtOnce` follow `prompt`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticationError, helloFailed, prompt, requestId]);

  const useHello = !!prompt?.requiresReauthentication && !!prompt.systemUnlock && !helloFailed;
  // A phrase to type, or weakened protections to read, come first; Hello
  // then answers the Allow button.
  const askHelloAtOnce = useHello && !prompt.confirmationPhrase && !prompt.securityChanges;
  const approvalBlocked =
    !prompt ||
    (!!prompt.confirmationPhrase && confirmation !== prompt.confirmationPhrase) ||
    (prompt.requiresReauthentication && !masterPassword && !useHello);

  const respond = async (approved: boolean) => {
    if (busy || (approved && approvalBlocked)) return;
    setBusy(true);
    try {
      await invoke('plugin:sensitive|respond_sensitive_confirmation', {
        requestId,
        approved,
        masterPassword: approved && prompt?.requiresReauthentication ? masterPassword : null,
        useSystemUnlock: approved && useHello,
      });
      setMasterPassword('');
    } catch {
      if (approved && prompt?.requiresReauthentication) {
        setMasterPassword('');
        setAttempt((n) => n + 1);
        if (useHello) setHelloFailed(true);
        else setAuthenticationError(true);
        setBusy(false);
        return;
      }
      await getCurrentWindow().close();
    }
  };

  // Windows Hello again, after it did not confirm: the same request, which
  // stays open for the password meanwhile.
  const retryHello = async () => {
    if (busy || (!!prompt?.confirmationPhrase && confirmation !== prompt.confirmationPhrase))
      return;
    setBusy(true);
    setAuthenticationError(false);
    try {
      await invoke('plugin:sensitive|respond_sensitive_confirmation', {
        requestId,
        approved: true,
        masterPassword: null,
        useSystemUnlock: true,
      });
    } catch {
      setAttempt((n) => n + 1);
      setBusy(false);
    }
  };

  useTooltip();

  return (
    // The unlock dialog's markup, so the two look alike.
    <main className="modal security-confirmation">
      <header className="modal-header" data-tauri-drag-region>
        <span
          ref={titleRef}
          className={`modal-title${titleTruncated ? ' truncated' : ''}`}
          data-tauri-drag-region
        >
          {titleText}
        </span>
        <button
          type="button"
          className="modal-close"
          aria-label={prompt ? cancelLabel : t('common.close')}
          disabled={busy}
          onClick={() => void respond(false)}
        >
          ✕
        </button>
      </header>
      <section ref={contentRef} className="modal-body security-confirmation__content">
        <p>
          {translationKey ? t(`${translationKey}.message`) : '…'}
          {prompt?.target && (
            <>
              <br />
              <br />
              {prompt.target}
            </>
          )}
          {prompt?.localName && (
            <>
              <br />
              {t('securityConfirmation.savedAs', { name: prompt.localName })}
            </>
          )}
          {prompt?.application && (
            <>
              <br />
              {t('securityConfirmation.program', { path: prompt.application })}
            </>
          )}
          {prompt?.hostKey && (
            <>
              <br />
              <br />
              {t('securityConfirmation.hostKey.server', { target: prompt.target })}
              {prompt.hostKey.expected && (
                <>
                  <br />
                  {t('securityConfirmation.hostKey.expected', {
                    fingerprint: prompt.hostKey.expected,
                  })}
                </>
              )}
              <br />
              {t('securityConfirmation.hostKey.actual', { fingerprint: prompt.hostKey.actual })}
            </>
          )}
          {prompt?.securityChanges?.strictHostKeyCheck === false && (
            <>
              <br />
              <br />
              {t('securityConfirmation.changes.strictHostKeyOff')}
            </>
          )}
          {prompt?.securityChanges?.showSecurityConfirmations === false && (
            <>
              <br />
              <br />
              {t('securityConfirmation.changes.confirmationsOff')}
            </>
          )}
          {typeof prompt?.securityChanges?.vaultAutoLockMinutes === 'number' && (
            <>
              <br />
              <br />
              {prompt.securityChanges.vaultAutoLockMinutes === 0
                ? t('securityConfirmation.changes.autoLockNever')
                : t('securityConfirmation.changes.autoLockMinutes', {
                    minutes: prompt.securityChanges.vaultAutoLockMinutes,
                  })}
            </>
          )}
          {prompt?.secretTransfer && (
            <>
              {prompt.kind !== 'transferSecret' && (
                <>
                  <br />
                  <br />
                  {t('securityConfirmation.operations.transferSecret.message')}
                </>
              )}
              <br />
              <br />
              {t('securityConfirmation.transferFrom', { recipient: prompt.secretTransfer.from })}
              <br />
              {t('securityConfirmation.transferTo', { recipient: prompt.secretTransfer.to })}
              {prompt.secretTransfer.lessSecure && (
                <>
                  <br />
                  <br />
                  <strong>{t('securityConfirmation.transferLessSecure')}</strong>
                </>
              )}
            </>
          )}
        </p>
        {prompt?.confirmationPhrase && (
          <label className="security-confirmation__confirmation">
            <span>
              {t('securityConfirmation.typeToConfirm', { phrase: prompt.confirmationPhrase })}
            </span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={prompt.confirmationPhrase}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && confirmation === prompt.confirmationPhrase) {
                  void respond(true);
                }
              }}
            />
          </label>
        )}
        {prompt?.requiresReauthentication && !useHello && (
          // Laid out as the unlock dialog in the main window.
          <div className="security-confirmation__password">
            <div className="vault-unlock-row">
              {prompt.systemUnlock && (
                <button
                  type="button"
                  className="btn btn-icon vault-system-unlock"
                  disabled={busy}
                  aria-label={t('settings.security.unlockWithSystem')}
                  data-tooltip={t('settings.security.unlockWithSystem')}
                  onClick={() => void retryHello()}
                >
                  <Icon name="fingerprintPattern" size={16} />
                </button>
              )}
              <label className="settings-field">
                <span>{t('settings.security.masterPassword')}</span>
                <input
                  type="password"
                  value={masterPassword}
                  autoComplete="current-password"
                  autoFocus
                  aria-invalid={authenticationError}
                  onChange={(event) => {
                    setMasterPassword(event.target.value);
                    setAuthenticationError(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && masterPassword) void respond(true);
                  }}
                />
              </label>
            </div>
            {(authenticationError || helloFailed) && (
              // A new attempt shows it afresh after it faded.
              <p
                key={attempt}
                className="settings-hint settings-warning vault-unlock-error"
                role="status"
              >
                {authenticationError
                  ? t('siteManagerDialog.revealFailed')
                  : t('securityConfirmation.systemUnlockFailed')}
              </p>
            )}
          </div>
        )}
      </section>
      <footer className="modal-footer">
        <button
          type="button"
          className="btn"
          disabled={!prompt || busy}
          onClick={() => void respond(false)}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || approvalBlocked}
          onClick={() => void respond(true)}
          autoFocus={!prompt?.confirmationPhrase}
        >
          {approveLabel}
        </button>
      </footer>
    </main>
  );
}
