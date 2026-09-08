import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon.tsx';

interface AppBannersProps {
  errorMessage: string;
  onDismissError: () => void;
  legacyPasswordNotice: boolean;
  onDismissLegacyPasswordNotice: () => void;
  plaintextSecretNotice: boolean;
  onDismissPlaintextSecretNotice: () => void;
  secretNotPersistedNotice: boolean;
  onDismissSecretNotPersistedNotice: () => void;
}

export default function AppBanners({
  errorMessage,
  onDismissError,
  legacyPasswordNotice,
  onDismissLegacyPasswordNotice,
  plaintextSecretNotice,
  onDismissPlaintextSecretNotice,
  secretNotPersistedNotice,
  onDismissSecretNotPersistedNotice,
}: AppBannersProps) {
  const { t } = useTranslation();

  return (
    <>
      {errorMessage && (
        <div className="app-error-bar" role="alert" aria-live="assertive">
          <span className="conn-error">{errorMessage}</span>
          <button
            type="button"
            className="app-error-bar-close"
            aria-label={t('common.close')}
            data-tooltip={t('common.close')}
            onClick={onDismissError}
          >
            <Icon name="windowClose" size={12} />
          </button>
        </div>
      )}

      {legacyPasswordNotice && (
        <div className="app-error-bar" role="status" aria-live="polite">
          <span>{t('legacyPasswordNotice.message')}</span>
          <button
            type="button"
            className="app-error-bar-close"
            aria-label={t('common.close')}
            data-tooltip={t('common.close')}
            onClick={onDismissLegacyPasswordNotice}
          >
            <Icon name="windowClose" size={12} />
          </button>
        </div>
      )}

      {plaintextSecretNotice && (
        <div className="app-error-bar" role="status" aria-live="polite">
          <span>{t('plaintextSecretNotice.message')}</span>
          <button
            type="button"
            className="app-error-bar-close"
            aria-label={t('common.close')}
            data-tooltip={t('common.close')}
            onClick={onDismissPlaintextSecretNotice}
          >
            <Icon name="windowClose" size={12} />
          </button>
        </div>
      )}

      {secretNotPersistedNotice && (
        <div className="app-error-bar" role="alert" aria-live="assertive">
          <span>{t('secretNotPersistedNotice.message')}</span>
          <button
            type="button"
            className="app-error-bar-close"
            aria-label={t('common.close')}
            data-tooltip={t('common.close')}
            onClick={onDismissSecretNotPersistedNotice}
          >
            <Icon name="windowClose" size={12} />
          </button>
        </div>
      )}
    </>
  );
}
