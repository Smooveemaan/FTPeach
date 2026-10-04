import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handler, reportRejection } from '../../../shared/asyncFailure.ts';
import Icon from '../../../components/Icon.tsx';

interface LoggingSettingsProps {
  logEnabledValue: boolean;
  setLogEnabledValue: (value: boolean) => void;
  logShowTimestampsValue: boolean;
  setLogShowTimestampsValue: (value: boolean) => void;
  logToFileValue: boolean;
  setLogToFileValue: (value: boolean) => void;
  /** Empty is FTPeach's own logs folder. */
  logFolderValue: string;
  setLogFolderValue: (value: string) => void;
  selectDirectory: () => Promise<string | null | undefined>;
  onOpenLogFolder: () => Promise<unknown>;
  onExportDiagnostics: () => Promise<{ ok?: boolean; canceled?: boolean }>;
}

export default function LoggingSettings({
  logEnabledValue,
  setLogEnabledValue,
  logShowTimestampsValue,
  setLogShowTimestampsValue,
  logToFileValue,
  setLogToFileValue,
  logFolderValue,
  setLogFolderValue,
  selectDirectory,
  onOpenLogFolder,
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
        <label className="settings-field">
          <span>{t('settings.logFolderLabel')}</span>
          <div className="saved-secret-control">
            <input
              type="text"
              aria-label={t('settings.logFolderLabel')}
              placeholder={t('settings.logFolderDefault')}
              value={logFolderValue}
              onChange={(e) => setLogFolderValue(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-icon field-icon-btn"
              aria-label={t('settings.chooseLogFolder')}
              data-tooltip={t('settings.chooseLogFolder')}
              onClick={handler(async () => {
                const selected = await selectDirectory();
                if (selected) setLogFolderValue(selected);
              })}
            >
              <Icon name="folder" size={14} />
            </button>
            {logFolderValue && (
              <button
                type="button"
                className="btn btn-icon field-icon-btn"
                aria-label={t('settings.resetLogFolder')}
                data-tooltip={t('settings.resetLogFolder')}
                onClick={() => setLogFolderValue('')}
              >
                <Icon name="windowClose" size={14} />
              </button>
            )}
          </div>
        </label>
        <button type="button" className="btn" onClick={() => reportRejection(onOpenLogFolder())}>
          {t('settings.openLogFolder')}
        </button>
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
