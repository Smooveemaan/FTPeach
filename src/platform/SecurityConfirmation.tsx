import { invoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, matchSupportedLanguage } from '../i18n/index.ts';
import { useTruncated } from '../hooks/useTruncated.ts';
import '../styles/security-confirmation.css';

type ConfirmationKind =
  | 'revealSiteSecret'
  | 'revealProxyPassword'
  | 'vaultReset'
  | 'executeLocalFile'
  | 'executeRemoteFile';

const OPERATION_TRANSLATION_KEYS: Record<ConfirmationKind, string> = {
  revealSiteSecret: 'securityConfirmation.operations.revealSiteSecret',
  revealProxyPassword: 'securityConfirmation.operations.revealProxyPassword',
  vaultReset: 'securityConfirmation.operations.vaultReset',
  executeLocalFile: 'securityConfirmation.operations.executeLocalFile',
  executeRemoteFile: 'securityConfirmation.operations.executeRemoteFile',
};

interface ConfirmationPrompt {
  kind: ConfirmationKind;
  locale: string;
  target?: string | null;
  confirmationPhrase?: string | null;
  requiresReauthentication: boolean;
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
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void invoke<ConfirmationPrompt>('plugin:sensitive|sensitive_confirmation_prompt', {
      requestId,
    })
      .then(async (nextPrompt) => {
        const locale = matchSupportedLanguage(nextPrompt.locale) ?? 'en';
        await changeLanguage(locale);
        document.documentElement.lang = locale;
        document.documentElement.dir = i18n.dir(locale);
        setPrompt(nextPrompt);
      })
      .catch(() => getCurrentWindow().close());
  }, [i18n, requestId]);

  const translationKey = prompt ? OPERATION_TRANSLATION_KEYS[prompt.kind] : null;
  const title = t('securityConfirmation.title');
  const titleText = prompt ? title : 'FTPeach';
  const [titleRef, titleTruncated] = useTruncated<HTMLSpanElement>([titleText]);
  const cancelLabel = t('common.cancel');
  const approveLabel = translationKey
    ? t(`${translationKey}.approve`, { defaultValue: t('securityConfirmation.allow') })
    : t('securityConfirmation.allow');

  useLayoutEffect(() => {
    if (!prompt || !contentRef.current) return;
    let cancelled = false;
    const resizeToContent = async () => {
      const content = contentRef.current;
      if (!content || cancelled) return;
      const titlebar = content.previousElementSibling as HTMLElement | null;
      const actions = content.nextElementSibling as HTMLElement | null;
      const message = content.querySelector('p');
      const availableWidth = Math.max(400, window.screen.availWidth - 48);
      const messageWidth = message?.scrollWidth ?? 0;
      const width = Math.ceil(Math.min(720, availableWidth, Math.max(400, messageWidth + 28)));
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
  }, [authenticationError, prompt, requestId]);

  const respond = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke('plugin:sensitive|respond_sensitive_confirmation', {
        requestId,
        approved,
        masterPassword: approved && prompt?.requiresReauthentication ? masterPassword : null,
      });
      setMasterPassword('');
    } catch {
      if (approved && prompt?.requiresReauthentication) {
        setMasterPassword('');
        setAuthenticationError(true);
        setBusy(false);
        return;
      }
      await getCurrentWindow().close();
    }
  };

  return (
    <main className="security-confirmation">
      <header className="security-confirmation__titlebar" data-tauri-drag-region>
        <span
          ref={titleRef}
          className={`security-confirmation__title${titleTruncated ? ' truncated' : ''}`}
          data-tauri-drag-region
        >
          {titleText}
        </span>
        <button
          type="button"
          className="security-confirmation__close"
          aria-label={prompt ? cancelLabel : t('common.close')}
          disabled={busy}
          onClick={() => void respond(false)}
        >
          ✕
        </button>
      </header>
      <section ref={contentRef} className="security-confirmation__content">
        <p>
          {translationKey ? t(`${translationKey}.message`) : '…'}
          {prompt?.target && (
            <>
              <br />
              <br />
              {prompt.target}
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
        {prompt?.requiresReauthentication && (
          <label className="security-confirmation__confirmation">
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
            {authenticationError && <span>{t('siteManagerDialog.revealFailed')}</span>}
          </label>
        )}
      </section>
      <footer className="security-confirmation__actions">
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
          disabled={
            !prompt ||
            busy ||
            (!!prompt.confirmationPhrase && confirmation !== prompt.confirmationPhrase) ||
            (prompt.requiresReauthentication && !masterPassword)
          }
          onClick={() => void respond(true)}
          autoFocus={!prompt?.confirmationPhrase}
        >
          {approveLabel}
        </button>
      </footer>
    </main>
  );
}
