import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import PasswordInput from '../../../components/PasswordInput.tsx';
import type { useProxyPasswordTest } from '../hooks/useProxyPasswordTest.ts';
import SegmentedControl from './SegmentedControl.tsx';
import { handler } from '../../../shared/asyncFailure.ts';

interface ProxySettingsProps {
  proxyTypeValue: string;
  setProxyTypeValue: (value: string) => void;
  proxyHostValue: string;
  setProxyHostValue: (value: string) => void;
  proxyPortValue: string;
  setProxyPortValue: (value: string) => void;
  proxyUsernameValue: string;
  setProxyUsernameValue: (value: string) => void;
  proxyPasswordSet: boolean;
  password: ReturnType<typeof useProxyPasswordTest>;
}

export default function ProxySettings({
  proxyTypeValue,
  setProxyTypeValue,
  proxyHostValue,
  setProxyHostValue,
  proxyPortValue,
  setProxyPortValue,
  proxyUsernameValue,
  setProxyUsernameValue,
  proxyPasswordSet,
  password,
}: ProxySettingsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.proxy.typeLabel')}</span>
          <SegmentedControl
            value={proxyTypeValue}
            onChange={setProxyTypeValue}
            options={[
              { value: 'socks5', label: 'SOCKS5' },
              { value: 'socks4', label: 'SOCKS4' },
              { value: 'http', label: 'HTTP' },
            ]}
          />
        </label>
      </div>
      <div className="settings-option-group settings-proxy-fields">
        <label className="settings-field">
          <span>{t('settings.proxy.hostLabel')}</span>
          <div className="settings-proxy-address">
            <input
              type="text"
              className="settings-proxy-field-grow"
              value={proxyHostValue}
              onChange={(e) => setProxyHostValue(e.target.value)}
              placeholder={t('settings.proxy.hostPlaceholder')}
            />
            <span>{t('settings.proxy.portLabel')}</span>
            <input
              type="number"
              className="settings-proxy-field-fixed"
              min={1}
              max={65535}
              value={proxyPortValue}
              onChange={(e) => setProxyPortValue(e.target.value)}
            />
          </div>
        </label>
        <label className="settings-field">
          <span>{t('settings.proxy.usernameLabel')}</span>
          <div className="settings-proxy-username-control">
            <input
              type="text"
              autoComplete="off"
              value={proxyUsernameValue}
              onChange={(e) => setProxyUsernameValue(e.target.value)}
            />
            {proxyPasswordSet && !password.proxyPasswordRemoved && (
              <span className="saved-secret-remove-spacer" aria-hidden="true" />
            )}
          </div>
        </label>
        <label className="settings-field">
          <span>{t('settings.proxy.passwordLabel')}</span>
          <div className="saved-secret-control">
            <PasswordInput
              placeholder={
                password.proxyPasswordRemoved
                  ? t('siteManagerDialog.secretWillBeRemoved')
                  : proxyPasswordSet
                    ? t('siteManagerDialog.savedSecretPlaceholder')
                    : undefined
              }
              value={password.proxyPasswordValue}
              onChange={(e) => password.setProxyPasswordValue(e.target.value)}
              protectedSecret={proxyPasswordSet && !password.proxyPasswordRemoved}
              onRevealSaved={password.revealSavedProxyPassword}
            />
            {proxyPasswordSet && !password.proxyPasswordRemoved && (
              <button
                type="button"
                className="btn btn-danger btn-icon saved-secret-remove"
                aria-label={t('settings.proxy.removeSavedPassword')}
                data-tooltip={t('settings.proxy.removeSavedPassword')}
                onClick={password.removeSavedProxyPassword}
              >
                <Icon name="trash" />
              </button>
            )}
          </div>
        </label>
        <label className="settings-field">
          <span>{t('settings.proxy.testTargetLabel')}</span>
          <div className="settings-proxy-test-controls">
            <input
              type="text"
              className="settings-proxy-field-grow"
              value={password.proxyTestHost}
              onChange={(e) => password.setProxyTestHost(e.target.value)}
              placeholder={t('settings.proxy.testTargetHostPlaceholder')}
            />
            <input
              type="number"
              className="settings-proxy-field-fixed"
              min={1}
              max={65535}
              value={password.proxyTestPort}
              onChange={(e) => password.setProxyTestPort(e.target.value)}
              placeholder={t('settings.proxy.testTargetPortPlaceholder')}
            />
            <button
              type="button"
              className="btn btn-icon settings-proxy-test-btn"
              disabled={
                password.proxyTestBusy ||
                !proxyHostValue.trim() ||
                !password.proxyTestHost.trim() ||
                !password.proxyTestPort
              }
              aria-label={
                password.proxyTestBusy ? t('settings.proxy.testing') : t('settings.proxy.test')
              }
              data-tooltip={
                password.proxyTestBusy ? t('settings.proxy.testing') : t('settings.proxy.test')
              }
              onClick={handler(password.testProxy)}
            >
              <Icon name="server" size={14} />
            </button>
          </div>
        </label>
        {password.proxyTestResult === 'ok' && (
          <p className="settings-hint settings-success">{t('settings.proxy.testOk')}</p>
        )}
        {password.proxyTestResult === 'error' && (
          <p
            className="settings-hint settings-warning settings-error-fade"
            role="alert"
            aria-live="assertive"
          >
            {password.proxyTestMessage}
          </p>
        )}
      </div>
    </>
  );
}
