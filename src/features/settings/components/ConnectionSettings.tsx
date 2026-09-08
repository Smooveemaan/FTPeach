import { useTranslation } from 'react-i18next';
import { MAX_TIMEOUT_SEC } from '../hooks/useSettingsDraft.ts';
import type { useProxyPasswordTest } from '../hooks/useProxyPasswordTest.ts';
import NumberStepper from './NumberStepper.tsx';
import ProxySettings from './ProxySettings.tsx';

interface ConnectionSettingsProps {
  timeoutValue: string;
  setTimeoutValue: (value: string) => void;
  saveSessionOnExitValue: boolean;
  setSaveSessionOnExitValue: (value: boolean) => void;
  autoReconnectTabsValue: boolean;
  setAutoReconnectTabsValue: (value: boolean) => void;
  ftpActiveModeValue: boolean;
  setFtpActiveModeValue: (value: boolean) => void;
  proxyEnabledValue: boolean;
  setProxyEnabledValue: (value: boolean) => void;
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

export default function ConnectionSettings({
  timeoutValue,
  setTimeoutValue,
  saveSessionOnExitValue,
  setSaveSessionOnExitValue,
  autoReconnectTabsValue,
  setAutoReconnectTabsValue,
  ftpActiveModeValue,
  setFtpActiveModeValue,
  proxyEnabledValue,
  setProxyEnabledValue,
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
}: ConnectionSettingsProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-option-list">
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.connectTimeoutLabel')}</span>
          <NumberStepper
            min={0}
            max={MAX_TIMEOUT_SEC}
            placeholder={t('settings.unlimitedPlaceholder')}
            value={timeoutValue}
            onChange={setTimeoutValue}
          />
        </label>
        <p className="settings-hint">{t('settings.connectTimeoutHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={saveSessionOnExitValue}
            onChange={(e) => setSaveSessionOnExitValue(e.target.checked)}
          />
          {t('settings.saveSessionOnExit')}
        </label>
        <p className="settings-hint">{t('settings.saveSessionOnExitHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={autoReconnectTabsValue}
            disabled={!saveSessionOnExitValue}
            onChange={(e) => setAutoReconnectTabsValue(e.target.checked)}
          />
          {t('settings.autoReconnectTabs')}
        </label>
        <p className="settings-hint">{t('settings.autoReconnectTabsHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={ftpActiveModeValue && !proxyEnabledValue}
            disabled={proxyEnabledValue}
            onChange={(e) => setFtpActiveModeValue(e.target.checked)}
          />
          {t('settings.ftpActiveMode')}
        </label>
        <p className="settings-hint">
          {proxyEnabledValue
            ? t('settings.ftpActiveModeDisabledByProxy')
            : t('settings.ftpActiveModeHint')}
        </p>
      </div>

      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={proxyEnabledValue}
            onChange={(e) => setProxyEnabledValue(e.target.checked)}
          />
          {t('settings.proxy.enable')}
        </label>
        <p className="settings-hint">{t('settings.proxy.enableHint')}</p>
      </div>

      {proxyEnabledValue && (
        <ProxySettings
          proxyTypeValue={proxyTypeValue}
          setProxyTypeValue={setProxyTypeValue}
          proxyHostValue={proxyHostValue}
          setProxyHostValue={setProxyHostValue}
          proxyPortValue={proxyPortValue}
          setProxyPortValue={setProxyPortValue}
          proxyUsernameValue={proxyUsernameValue}
          setProxyUsernameValue={setProxyUsernameValue}
          proxyPasswordSet={proxyPasswordSet}
          password={password}
        />
      )}
    </div>
  );
}
