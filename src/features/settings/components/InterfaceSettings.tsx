import { useTranslation } from 'react-i18next';
import LanguageSelect from '../../../components/LanguageSelect.tsx';
import InterfaceScaleSelect from '../../../components/InterfaceScaleSelect.tsx';
import DateFormatSelect, {
  DATE_FORMAT_OPTIONS,
  TimeFormatSelect,
} from '../../../components/DateFormatSelect.tsx';
import Icon from '../../../components/Icon.tsx';
import type { SupportedLanguage } from '../../../i18n/index.ts';
import SegmentedControl from './SegmentedControl.tsx';
import { handler } from '../../../shared/asyncFailure.ts';

interface InterfaceSettingsProps {
  themeValue: string;
  setThemeValue: (value: string) => void;
  languageValue: SupportedLanguage;
  setLanguageValue: (value: SupportedLanguage) => void;
  interfaceScaleValue: number;
  setInterfaceScaleValue: (value: number) => void;
  dateFormatValue: string;
  setDateFormatValue: (value: string) => void;
  defaultLocalPathValue: string;
  setDefaultLocalPathValue: (value: string) => void;
  showHiddenFilesValue: boolean;
  setShowHiddenFilesValue: (value: boolean) => void;
  coloredTabsValue: boolean;
  setColoredTabsValue: (value: boolean) => void;
  minimizeToTrayValue: boolean;
  setMinimizeToTrayValue: (value: boolean) => void;
  closeToTrayValue: boolean;
  /** Native directory picker. Injected so this section stays presentational. */
  selectDirectory: () => Promise<string | null>;
  setCloseToTrayValue: (value: boolean) => void;
}

export default function InterfaceSettings({
  themeValue,
  setThemeValue,
  languageValue,
  setLanguageValue,
  interfaceScaleValue,
  setInterfaceScaleValue,
  dateFormatValue,
  setDateFormatValue,
  defaultLocalPathValue,
  setDefaultLocalPathValue,
  showHiddenFilesValue,
  setShowHiddenFilesValue,
  coloredTabsValue,
  setColoredTabsValue,
  minimizeToTrayValue,
  setMinimizeToTrayValue,
  closeToTrayValue,
  setCloseToTrayValue,
  selectDirectory,
}: InterfaceSettingsProps) {
  const { t } = useTranslation();
  const dateOnlyFormat =
    DATE_FORMAT_OPTIONS.find((option) => dateFormatValue.startsWith(option.value))?.value ||
    'locale';
  const timeOnlyFormat = dateFormatValue.endsWith('hh:mm a') ? 'hh:mm a' : 'HH:mm';
  const usesPresetFormat = dateOnlyFormat === 'locale' || dateOnlyFormat === 'iso';

  const chooseDefaultLocalPath = async () => {
    const selected = await selectDirectory();
    if (selected) setDefaultLocalPathValue(selected);
  };

  return (
    <div className="settings-option-list">
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.themeLabel')}</span>
          <SegmentedControl
            value={themeValue}
            onChange={setThemeValue}
            options={[
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
              { value: 'system', label: t('settings.themeSystem') },
            ]}
          />
        </label>
      </div>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.languageLabel')}</span>
          <LanguageSelect value={languageValue} onChange={setLanguageValue} />
        </label>
      </div>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.interfaceScaleLabel')}</span>
          <InterfaceScaleSelect
            value={interfaceScaleValue}
            onChange={setInterfaceScaleValue}
            label={t('settings.interfaceScaleLabel')}
          />
        </label>
        <p className="settings-hint">{t('settings.interfaceScaleHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.dateFormatLabel')}</span>
          <div className="date-time-format-controls">
            <DateFormatSelect
              value={dateOnlyFormat}
              onChange={(value) =>
                setDateFormatValue(
                  value === 'locale' || value === 'iso' ? value : `${value} ${timeOnlyFormat}`,
                )
              }
              label={t('settings.dateFormatOnlyLabel')}
              localLabel={t('settings.dateFormatLocale')}
              isoLabel={t('settings.dateFormatIso')}
            />
            <TimeFormatSelect
              value={timeOnlyFormat}
              onChange={(value) => setDateFormatValue(`${dateOnlyFormat} ${value}`)}
              label={t('settings.timeFormatLabel')}
              hour24Label={t('settings.timeFormat24Hour')}
              hour12Label={t('settings.timeFormat12Hour')}
              disabled={usesPresetFormat}
            />
          </div>
        </label>
      </div>
      <div className="settings-option-group">
        <label className="settings-field">
          <span>{t('settings.defaultLocalPathLabel')}</span>
          <div className="saved-secret-control">
            <input
              type="text"
              aria-label={t('settings.defaultLocalPathLabel')}
              value={defaultLocalPathValue}
              onChange={(e) => setDefaultLocalPathValue(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={t('settings.chooseDefaultLocalPath')}
              onClick={handler(chooseDefaultLocalPath)}
            >
              <Icon name="folder" />
            </button>
          </div>
        </label>
        <p className="settings-hint">{t('settings.defaultLocalPathHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={showHiddenFilesValue}
            onChange={(e) => setShowHiddenFilesValue(e.target.checked)}
          />
          {t('settings.showHiddenFiles')}
        </label>
        <p className="settings-hint">{t('settings.showHiddenFilesHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={coloredTabsValue}
            onChange={(e) => setColoredTabsValue(e.target.checked)}
          />
          {t('settings.coloredTabs')}
        </label>
        <p className="settings-hint">{t('settings.coloredTabsHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={minimizeToTrayValue}
            onChange={(e) => setMinimizeToTrayValue(e.target.checked)}
          />
          {t('settings.minimizeToTray')}
        </label>
        <p className="settings-hint">{t('settings.minimizeToTrayHint')}</p>
      </div>
      <div className="settings-option-group">
        <label className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={closeToTrayValue}
            onChange={(e) => setCloseToTrayValue(e.target.checked)}
          />
          {t('settings.closeToTray')}
        </label>
        <p className="settings-hint">{t('settings.closeToTrayHint')}</p>
      </div>
    </div>
  );
}
