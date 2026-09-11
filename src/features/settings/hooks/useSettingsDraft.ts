import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { SupportedLanguage } from '../../../i18n/index.ts';
import { matchSupportedLanguage } from '../../../i18n/index.ts';
import { friendlyError } from '../../../shared/errorMessages.ts';
import type { SettingsPatch, SettingsValues } from '../useSettings.ts';

export type SettingsDraftValues = Pick<
  SettingsValues,
  | 'concurrency'
  | 'connectTimeout'
  | 'notifyOnTransferComplete'
  | 'overwriteAction'
  | 'ftpActiveMode'
  | 'proxyEnabled'
  | 'proxyType'
  | 'proxyHost'
  | 'proxyPort'
  | 'proxyUsername'
  | 'preventSleepDuringTransfers'
  | 'transferSpeedLimitKBps'
  | 'openWithAssociations'
  | 'theme'
  | 'language'
  | 'interfaceScale'
  | 'dateFormat'
  | 'defaultLocalPath'
  | 'showHiddenFiles'
  | 'coloredTabs'
  | 'minimizeToTray'
  | 'closeToTray'
  | 'autoCheckUpdates'
  | 'autoReconnectTabs'
  | 'saveSessionOnExit'
  | 'logEnabled'
  | 'logShowTimestamps'
  | 'logToFile'
  | 'vaultAutoLockMinutes'
  | 'showSecurityConfirmations'
  | 'keyboardShortcuts'
>;

export interface ProxyPasswordPatch {
  proxyPassword?: string;
  removeProxyPassword?: true;
}

export type SettingsSaveResult = void | { ok: boolean; error?: string };
export type SaveSettings = (
  patch: SettingsPatch,
) => SettingsSaveResult | Promise<SettingsSaveResult>;

interface UseSettingsDraftOptions extends SettingsDraftValues {
  onPreview: (patch: SettingsPatch) => unknown;
  onSave: SaveSettings;
  onClose: () => unknown;
}

interface AssociationRow {
  extension: string;
  application: string;
}

interface SettingsDraft {
  concurrencyValue: string;
  timeoutValue: string;
  notifyValue: SettingsValues['notifyOnTransferComplete'];
  overwriteActionValue: SettingsValues['overwriteAction'];
  ftpActiveModeValue: boolean;
  proxyEnabledValue: boolean;
  proxyTypeValue: SettingsValues['proxyType'];
  proxyHostValue: string;
  proxyPortValue: string;
  proxyUsernameValue: string;
  preventSleepValue: boolean;
  speedLimitValue: string;
  openWithAssociationRows: AssociationRow[];
  shortcutOverridesValue: SettingsValues['keyboardShortcuts'];
  themeValue: SettingsValues['theme'];
  languageValue: SupportedLanguage;
  interfaceScaleValue: number;
  dateFormatValue: SettingsValues['dateFormat'];
  defaultLocalPathValue: string;
  showHiddenFilesValue: boolean;
  coloredTabsValue: boolean;
  minimizeToTrayValue: boolean;
  closeToTrayValue: boolean;
  autoCheckUpdatesValue: boolean;
  autoReconnectTabsValue: boolean;
  saveSessionOnExitValue: boolean;
  logEnabledValue: boolean;
  logShowTimestampsValue: boolean;
  logToFileValue: boolean;
  vaultAutoLockValue: string;
  showSecurityConfirmationsValue: boolean;
}

type DraftAction = {
  [Key in keyof SettingsDraft]: {
    field: Key;
    value: SetStateAction<SettingsDraft[Key]>;
  };
}[keyof SettingsDraft];

const MIN_TIMEOUT_SEC = 5;
export const MAX_TIMEOUT_SEC = 120;

function createDraft(settings: SettingsDraftValues): SettingsDraft {
  return {
    concurrencyValue: settings.concurrency ? String(settings.concurrency) : '',
    timeoutValue: settings.connectTimeout ? String(Math.round(settings.connectTimeout / 1000)) : '',
    notifyValue: settings.notifyOnTransferComplete,
    overwriteActionValue: settings.overwriteAction,
    ftpActiveModeValue: !!settings.ftpActiveMode,
    proxyEnabledValue: !!settings.proxyEnabled,
    proxyTypeValue: settings.proxyType || 'socks5',
    proxyHostValue: settings.proxyHost || '',
    proxyPortValue: settings.proxyPort ? String(settings.proxyPort) : '1080',
    proxyUsernameValue: settings.proxyUsername || '',
    preventSleepValue: settings.preventSleepDuringTransfers !== false,
    speedLimitValue: settings.transferSpeedLimitKBps ? String(settings.transferSpeedLimitKBps) : '',
    openWithAssociationRows: Object.entries(settings.openWithAssociations).map(
      ([extension, application]) => ({ extension, application }),
    ),
    shortcutOverridesValue: { ...settings.keyboardShortcuts },
    themeValue: settings.theme,
    languageValue: matchSupportedLanguage(settings.language) || 'ru',
    interfaceScaleValue: settings.interfaceScale || 100,
    dateFormatValue: settings.dateFormat || 'locale',
    defaultLocalPathValue: settings.defaultLocalPath || '',
    showHiddenFilesValue: !!settings.showHiddenFiles,
    coloredTabsValue: settings.coloredTabs !== false,
    minimizeToTrayValue: !!settings.minimizeToTray,
    closeToTrayValue: !!settings.closeToTray,
    autoCheckUpdatesValue: settings.autoCheckUpdates !== false,
    autoReconnectTabsValue: !!settings.autoReconnectTabs,
    saveSessionOnExitValue: settings.saveSessionOnExit !== false,
    logEnabledValue: !!settings.logEnabled,
    logShowTimestampsValue: settings.logShowTimestamps !== false,
    logToFileValue: !!settings.logToFile,
    vaultAutoLockValue: settings.vaultAutoLockMinutes ? String(settings.vaultAutoLockMinutes) : '',
    showSecurityConfirmationsValue: settings.showSecurityConfirmations !== false,
  };
}

function draftReducer(state: SettingsDraft, action: DraftAction): SettingsDraft {
  const previous = state[action.field];
  const next =
    typeof action.value === 'function'
      ? (action.value as (value: typeof previous) => typeof previous)(previous)
      : action.value;
  return { ...state, [action.field]: next };
}

function buildPatch(draft: SettingsDraft): SettingsPatch {
  const concurrency = Math.min(10, Math.max(0, Number(draft.concurrencyValue) || 0));
  const rawTimeoutSec = Number(draft.timeoutValue) || 0;
  const timeoutSec =
    rawTimeoutSec === 0 ? 0 : Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, rawTimeoutSec));
  const speedLimit = Math.max(0, Math.round(Number(draft.speedLimitValue) || 0));
  const vaultAutoLock = Math.min(
    1440,
    Math.max(0, Math.round(Number(draft.vaultAutoLockValue) || 0)),
  );
  const openWithAssociations = Object.fromEntries(
    draft.openWithAssociationRows
      .map(({ extension, application }): [string, string] => [
        extension.trim().replace(/^\.+/, '').toLowerCase(),
        application.trim(),
      ])
      .filter(
        ([extension, application]) => /^[a-z0-9][a-z0-9_-]*$/i.test(extension) && application,
      ),
  );
  return {
    concurrency,
    connectTimeout: timeoutSec * 1000,
    notifyOnTransferComplete: draft.notifyValue,
    overwriteAction: draft.overwriteActionValue,
    ftpActiveMode: draft.ftpActiveModeValue,
    proxyEnabled: draft.proxyEnabledValue,
    proxyType: draft.proxyTypeValue,
    proxyHost: draft.proxyHostValue.trim(),
    proxyPort: Math.min(65535, Math.max(1, Math.round(Number(draft.proxyPortValue) || 0))) || 1080,
    proxyUsername: draft.proxyUsernameValue,
    preventSleepDuringTransfers: draft.preventSleepValue,
    transferSpeedLimitKBps: speedLimit,
    openWithAssociations,
    theme: draft.themeValue,
    language: draft.languageValue,
    interfaceScale: Number(draft.interfaceScaleValue),
    dateFormat: draft.dateFormatValue,
    defaultLocalPath: draft.defaultLocalPathValue.trim(),
    showHiddenFiles: draft.showHiddenFilesValue,
    coloredTabs: draft.coloredTabsValue,
    minimizeToTray: draft.minimizeToTrayValue,
    closeToTray: draft.closeToTrayValue,
    autoCheckUpdates: draft.autoCheckUpdatesValue,
    autoReconnectTabs: draft.autoReconnectTabsValue,
    saveSessionOnExit: draft.saveSessionOnExitValue,
    logEnabled: draft.logEnabledValue,
    logShowTimestamps: draft.logShowTimestampsValue,
    logToFile: draft.logToFileValue,
    vaultAutoLockMinutes: vaultAutoLock,
    showSecurityConfirmations: draft.showSecurityConfirmationsValue,
    keyboardShortcuts: draft.shortcutOverridesValue,
  };
}

type SettingsDraftSetters = {
  [Key in keyof SettingsDraft as `set${Capitalize<Key>}`]: Dispatch<
    SetStateAction<SettingsDraft[Key]>
  >;
};

export interface SettingsDraftModel extends SettingsDraft, SettingsDraftSetters {
  saving: boolean;
  saveError: string | undefined;
  hasUnsavedChanges: boolean;
  confirmCloseArmed: boolean;
  setConfirmCloseArmed: Dispatch<SetStateAction<boolean>>;
  markUnsavedChanges: () => void;
  handleSave: (vaultBusy: boolean, proxyPasswordPatch?: ProxyPasswordPatch) => Promise<void>;
  discardAndClose: () => void;
  requestClose: (vaultBusy: boolean) => void;
}

export function useSettingsDraft(options: UseSettingsDraftOptions): SettingsDraftModel {
  const { onPreview, onSave, onClose, ...initialSettings } = options;
  const [draft, dispatch] = useReducer(draftReducer, initialSettings, createDraft);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string>();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [confirmCloseArmed, setConfirmCloseArmed] = useState(false);
  const isFirstPreviewRef = useRef(true);
  const originalPatchRef = useRef<SettingsPatch>(initialSettings);

  const setter =
    <Key extends keyof SettingsDraft>(field: Key): Dispatch<SetStateAction<SettingsDraft[Key]>> =>
    (value) =>
      dispatch({ field, value } as DraftAction);

  useEffect(() => {
    onPreview(buildPatch(draft));
    if (isFirstPreviewRef.current) isFirstPreviewRef.current = false;
    else setHasUnsavedChanges(true);
    // Preview callbacks intentionally retain the instance captured when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const markUnsavedChanges = () => setHasUnsavedChanges(true);
  const handleSave = async (vaultBusy: boolean, proxyPasswordPatch: ProxyPasswordPatch = {}) => {
    if (vaultBusy || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await onSave({ ...buildPatch(draft), ...proxyPasswordPatch });
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error('error' in result ? String(result.error) : 'Settings could not be saved');
      }
      onClose();
    } catch (error) {
      setSaveError(friendlyError(error instanceof Error ? error : String(error)) || String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const discardAndClose = () => {
    if (savingRef.current) return;
    onPreview(originalPatchRef.current);
    onClose();
  };
  const requestClose = (vaultBusy: boolean) => {
    if (vaultBusy || savingRef.current) return;
    if (hasUnsavedChanges) {
      setConfirmCloseArmed(true);
      return;
    }
    discardAndClose();
  };

  return {
    ...draft,
    setConcurrencyValue: setter('concurrencyValue'),
    setTimeoutValue: setter('timeoutValue'),
    setNotifyValue: setter('notifyValue'),
    setOverwriteActionValue: setter('overwriteActionValue'),
    setFtpActiveModeValue: setter('ftpActiveModeValue'),
    setProxyEnabledValue: setter('proxyEnabledValue'),
    setProxyTypeValue: setter('proxyTypeValue'),
    setProxyHostValue: setter('proxyHostValue'),
    setProxyPortValue: setter('proxyPortValue'),
    setProxyUsernameValue: setter('proxyUsernameValue'),
    setPreventSleepValue: setter('preventSleepValue'),
    setSpeedLimitValue: setter('speedLimitValue'),
    setOpenWithAssociationRows: setter('openWithAssociationRows'),
    setShortcutOverridesValue: setter('shortcutOverridesValue'),
    setThemeValue: setter('themeValue'),
    setLanguageValue: setter('languageValue'),
    setInterfaceScaleValue: setter('interfaceScaleValue'),
    setDateFormatValue: setter('dateFormatValue'),
    setDefaultLocalPathValue: setter('defaultLocalPathValue'),
    setShowHiddenFilesValue: setter('showHiddenFilesValue'),
    setColoredTabsValue: setter('coloredTabsValue'),
    setMinimizeToTrayValue: setter('minimizeToTrayValue'),
    setCloseToTrayValue: setter('closeToTrayValue'),
    setAutoCheckUpdatesValue: setter('autoCheckUpdatesValue'),
    setAutoReconnectTabsValue: setter('autoReconnectTabsValue'),
    setSaveSessionOnExitValue: setter('saveSessionOnExitValue'),
    setLogEnabledValue: setter('logEnabledValue'),
    setLogShowTimestampsValue: setter('logShowTimestampsValue'),
    setLogToFileValue: setter('logToFileValue'),
    setVaultAutoLockValue: setter('vaultAutoLockValue'),
    setShowSecurityConfirmationsValue: setter('showSecurityConfirmationsValue'),
    saving,
    saveError,
    hasUnsavedChanges,
    confirmCloseArmed,
    setConfirmCloseArmed,
    markUnsavedChanges,
    handleSave,
    discardAndClose,
    requestClose,
  };
}
