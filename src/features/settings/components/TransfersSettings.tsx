import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import type { OverwriteAction } from '../useSettings.ts';
import NumberStepper from './NumberStepper.tsx';
import SegmentedControl from './SegmentedControl.tsx';
import { handler } from '../../../shared/asyncFailure.ts';

interface OpenWithAssociationRow {
  extension: string;
  application: string;
}

interface TransfersSettingsProps {
  concurrencyValue: string;
  setConcurrencyValue: (value: string) => void;
  speedLimitValue: string;
  setSpeedLimitValue: (value: string) => void;
  notifyValue: boolean;
  setNotifyValue: (value: boolean) => void;
  overwriteActionValue: OverwriteAction;
  setOverwriteActionValue: (value: OverwriteAction) => void;
  preventSleepValue: boolean;
  setPreventSleepValue: (value: boolean) => void;
  openWithAssociationRows: OpenWithAssociationRow[];
  setOpenWithAssociationRows: (
    update: (rows: OpenWithAssociationRow[]) => OpenWithAssociationRow[],
  ) => void;
  /** Native application picker. Injected so this section stays presentational. */
  selectApplication: () => Promise<string | null>;
}

export default function TransfersSettings({
  concurrencyValue,
  setConcurrencyValue,
  speedLimitValue,
  setSpeedLimitValue,
  notifyValue,
  setNotifyValue,
  overwriteActionValue,
  setOverwriteActionValue,
  preventSleepValue,
  setPreventSleepValue,
  openWithAssociationRows,
  setOpenWithAssociationRows,
  selectApplication,
}: TransfersSettingsProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-option-list">
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.concurrencyLabel')}</span>
          <NumberStepper
            min={0}
            max={10}
            placeholder={t('settings.unlimitedPlaceholder')}
            value={concurrencyValue}
            onChange={setConcurrencyValue}
          />
        </label>
        <p className="settings-hint">{t('settings.concurrencyHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.speedLimitLabel')}</span>
          <NumberStepper
            min={0}
            placeholder={t('settings.unlimitedPlaceholder')}
            value={speedLimitValue}
            onChange={setSpeedLimitValue}
          />
        </label>
        <p className="settings-hint">{t('settings.speedLimitHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={notifyValue}
            onChange={(e) => setNotifyValue(e.target.checked)}
          />
          {t('settings.notifyOnComplete')}
        </label>
        <p className="settings-hint">{t('settings.notifyOnCompleteHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.overwriteActionLabel')}</span>
          <SegmentedControl
            value={overwriteActionValue}
            onChange={setOverwriteActionValue}
            options={[
              { value: 'ask', label: t('settings.overwriteAsk') },
              { value: 'overwrite', label: t('settings.overwriteOverwrite') },
              { value: 'skip', label: t('settings.overwriteSkip') },
            ]}
          />
        </label>
        <p className="settings-hint">{t('settings.overwriteHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={preventSleepValue}
            onChange={(e) => setPreventSleepValue(e.target.checked)}
          />
          {t('settings.preventSleep')}
        </label>
        <p className="settings-hint">{t('settings.preventSleepHint')}</p>
      </div>
      <div className="settings-option-group">
        <div className="settings-openwith-heading">
          <span className="settings-group-title">{t('settings.openWithAssociations.title')}</span>
          <button
            type="button"
            className="btn btn-icon settings-openwith-add"
            aria-label={t('settings.openWithAssociations.add')}
            data-tooltip={t('settings.openWithAssociations.add')}
            onClick={() =>
              setOpenWithAssociationRows((current) => [
                ...current,
                { extension: '', application: '' },
              ])
            }
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <p className="settings-hint">{t('settings.openWithAssociations.hint')}</p>
        {openWithAssociationRows.length > 0 && (
          <div className="settings-openwith-list">
            <div className="settings-openwith-columns" aria-hidden="true">
              <span>{t('settings.openWithAssociations.extension')}</span>
              <span>{t('settings.openWithAssociations.application')}</span>
              <span />
            </div>
            {openWithAssociationRows.map((row, index) => (
              <div className="settings-openwith-row" key={index}>
                <label className="settings-openwith-field settings-openwith-extension">
                  <div className="settings-openwith-extension-input">
                    <span aria-hidden="true">.</span>
                    <input
                      type="text"
                      aria-label={t('settings.openWithAssociations.extension')}
                      placeholder={t('settings.openWithAssociations.extensionPlaceholder')}
                      value={row.extension}
                      onChange={(event) =>
                        setOpenWithAssociationRows((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, extension: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                </label>
                <label className="settings-openwith-field">
                  <input
                    type="text"
                    className="settings-openwith-application-input"
                    aria-label={t('settings.openWithAssociations.application')}
                    placeholder={t('settings.openWithAssociations.applicationPlaceholder')}
                    value={row.application}
                    onChange={(event) =>
                      setOpenWithAssociationRows((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, application: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </label>
                <div className="settings-openwith-actions">
                  <button
                    type="button"
                    className="btn btn-icon settings-shortcut-icon-btn settings-openwith-browse"
                    aria-label={t('settings.openWithAssociations.browse')}
                    data-tooltip={t('settings.openWithAssociations.browse')}
                    onClick={handler(async () => {
                      const application = await selectApplication();
                      if (application)
                        setOpenWithAssociationRows((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, application } : item,
                          ),
                        );
                    })}
                  >
                    <Icon name="folder" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon settings-shortcut-icon-btn"
                    aria-label={t('settings.openWithAssociations.remove')}
                    data-tooltip={t('settings.openWithAssociations.remove')}
                    onClick={() =>
                      setOpenWithAssociationRows((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
