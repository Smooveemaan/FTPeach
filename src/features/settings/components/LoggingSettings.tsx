import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handler } from '../../../shared/asyncFailure.ts';

interface LoggingSettingsProps {
  logEnabledValue: boolean;
  setLogEnabledValue: (value: boolean) => void;
  logShowTimestampsValue: boolean;
  setLogShowTimestampsValue: (value: boolean) => void;
  logToFileValue: boolean;
  setLogToFileValue: (value: boolean) => void;
  onExportDiagnostics: () => Promise<{ ok?: boolean; canceled?: boolean }>;
}

export default function LoggingSettings({
  logEnabledValue,
  setLogEnabledValue,
  logShowTimestampsValue,
  setLogShowTimestampsValue,
  logToFileValue,
  setLogToFileValue,
  onExportDiagnostics,
}: LoggingSettingsProps) {
  const { t } = useTranslation();
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [diagnosticsExportFailed, setDiagnosticsExportFailed] = useState(false);

  const handleExportDiagnostics = async () => {
    setExportingDiagnostics(true);
    setDiagnosticsExportFailed(false);
    try {
      const result = await onExportDiagnostics();
      if (!result.ok && !result.canceled) setDiagnosticsExportFailed(true);
    } catch {
      setDiagnosticsExportFailed(true);
    } finally {
      setExportingDiagnostics(false);
    }
  };

  return (
    <div className="settings-option-list">
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={logEnabledValue}
            onChange={(e) => setLogEnabledValue(e.target.checked)}
          />
          {t('settings.logEnable')}
        </label>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={logShowTimestampsValue}
            disabled={!logEnabledValue}
            onChange={(e) => setLogShowTimestampsValue(e.target.checked)}
          />
          {t('settings.logShowTimestamps')}
        </label>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={logToFileValue}
            onChange={(e) => setLogToFileValue(e.target.checked)}
          />
          {t('settings.logToFile')}
        </label>
        <p className="settings-hint">{t('settings.logToFileHint')}</p>
      </div>
      <div className="settings-option-group">
        <button
          type="button"
          className="btn"
          onClick={handler(handleExportDiagnostics)}
          disabled={exportingDiagnostics}
        >
          {exportingDiagnostics
            ? t('settings.exportDiagnosticsBusy')
            : t('settings.exportDiagnostics')}
        </button>
        <p className={`settings-hint${diagnosticsExportFailed ? ' settings-error' : ''}`}>
          {diagnosticsExportFailed
            ? t('settings.exportDiagnosticsFailed')
            : t('settings.exportDiagnosticsHint')}
        </p>
      </div>
    </div>
  );
}
