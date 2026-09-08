import { useTranslation } from 'react-i18next';
import type { UpdaterStatus } from '../../../platform/ipcContracts.ts';
import type { Translate } from '../../../shared/types.ts';

interface UpdatesSettingsProps {
  autoCheckUpdatesValue: boolean;
  setAutoCheckUpdatesValue: (value: boolean) => void;
  updateStatus: UpdaterStatus | null;
  checkForUpdates: () => unknown;
}

const updateCheckLabels = (t: Translate): Partial<Record<UpdaterStatus['state'], string>> => ({
  checking: t('settings.updateStatus.checking'),
  'not-available': t('settings.updateStatus.notAvailable'),
  error: t('settings.updateStatus.error'),
  'not-packaged': t('settings.updateStatus.notPackaged'),
});

export default function UpdatesSettings({
  autoCheckUpdatesValue,
  setAutoCheckUpdatesValue,
  updateStatus,
  checkForUpdates,
}: UpdatesSettingsProps) {
  const { t } = useTranslation();
  const UPDATE_CHECK_LABELS = updateCheckLabels(t);

  return (
    <div className="settings-option-list">
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={autoCheckUpdatesValue}
            onChange={(e) => setAutoCheckUpdatesValue(e.target.checked)}
          />
          {t('settings.autoCheckUpdates')}
        </label>
        <p className="settings-hint">{t('settings.autoCheckUpdatesHint')}</p>
      </div>
      <div className="settings-option-group">
        <button
          type="button"
          className="btn"
          onClick={checkForUpdates}
          disabled={updateStatus?.state === 'checking'}
        >
          {t('settings.checkNow')}
        </button>
        {updateStatus && UPDATE_CHECK_LABELS[updateStatus.state] && (
          <p className="settings-hint">{UPDATE_CHECK_LABELS[updateStatus.state]}</p>
        )}
      </div>
    </div>
  );
}
