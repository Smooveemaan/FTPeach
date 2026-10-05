import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_TIMEOUT_SEC } from '../hooks/useSettingsDraft.ts';
import NumberStepper from './NumberStepper.tsx';
import ProxySettings, { type ProxyMotion, type ProxySettingsProps } from './ProxySettings.tsx';

interface ConnectionSettingsProps extends Omit<ProxySettingsProps, 'motion' | 'onFolded'> {
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
  ...proxy
}: ConnectionSettingsProps) {
  const { t } = useTranslation();
  // Switched on or off here, the proxy fields unfold or fold; opened with it
  // on, they are just there.
  const [proxyMotion, setProxyMotion] = useState<ProxyMotion>('none');

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
            onChange={(e) => {
              setProxyEnabledValue(e.target.checked);
              setProxyMotion(e.target.checked ? 'unfold' : 'fold');
            }}
          />
          {t('settings.proxy.enable')}
        </label>
        <p className="settings-hint">{t('settings.proxy.enableHint')}</p>
      </div>

      {(proxyEnabledValue || proxyMotion === 'fold') && (
        <ProxySettings motion={proxyMotion} onFolded={() => setProxyMotion('none')} {...proxy} />
      )}
    </div>
  );
}
