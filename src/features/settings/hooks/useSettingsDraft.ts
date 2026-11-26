import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { SupportedLanguage } from '../../../i18n/index.ts';
import { matchSupportedLanguage } from '../../../i18n/index.ts';
import { api } from '../../../platform/api/index.ts';
import {
  CommandFailure,
  isCancellation,
  MAX_TRANSFER_CONCURRENCY,
} from '../../../platform/ipcContracts.ts';
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
  | 'colorScheme'
  | 'language'
  | 'interfaceScale'
  | 'fileListScale'
  | 'terminalFontSize'
  | 'dateFormat'
  | 'defaultLocalPath'
  | 'showHiddenFiles'
  | 'coloredTabs'
  | 'minimizeToTray'
  | 'closeToTray'
  | 'showMenuBarIcon'
  | 'autoCheckUpdates'
  | 'autoReconnectTabs'
  | 'saveSessionOnExit'
  | 'logEnabled'
  | 'logShowTimestamps'
  | 'logToFile'
  | 'extendedLogging'
  | 'extendedLoggingUntil'
  | 'logFolder'
  | 'vaultAutoLockMinutes'
  | 'showSecurityConfirmations'
  | 'strictHostKeyCheck'
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

export interface SaveDraftOptions {
  closeAfter?: boolean;
  onSaved?: () => void;
}

interface UseSettingsDraftOptions extends SettingsDraftValues {
  onPreview: (patch: SettingsPatch) => unknown;
  onSave: SaveSettings;
  onClose: () => unknown;
  onVaultUnlockRequired: (retry: () => void) => void;
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
  colorSchemeValue: string;
  languageValue: SupportedLanguage;
  interfaceScaleValue: number;
  fileListScaleValue: number;
  terminalFontSizeValue: number;
  dateFormatValue: SettingsValues['dateFormat'];
  defaultLocalPathValue: string;
  showHiddenFilesValue: boolean;
  coloredTabsValue: boolean;
  minimizeToTrayValue: boolean;
  closeToTrayValue: boolean;
  showMenuBarIconValue: boolean;
  autoCheckUpdatesValue: boolean;
  autoReconnectTabsValue: boolean;
  saveSessionOnExitValue: boolean;
  logEnabledValue: boolean;
  logShowTimestampsValue: boolean;
  logToFileValue: boolean;
  extendedLoggingValue: boolean;
  logFolderValue: string;
  vaultAutoLockValue: string;
  showSecurityConfirmationsValue: boolean;
  strictHostKeyCheckValue: boolean;
}

type DraftAction =
  | { type: 'reset'; draft: SettingsDraft }
  | {
      [Key in keyof SettingsDraft]: {
        type?: 'set';
        field: Key;
        value: SetStateAction<SettingsDraft[Key]>;
      };
    }[keyof SettingsDraft];

export const EXTENDED_LOGGING_TTL_MS = 24 * 60 * 60 * 1000;

function nextExtendedLoggingUntil(
  changedExtendedLogging: unknown,
  extendedLoggingValue: boolean,
  previousUntil: number | null,
): number | null | undefined {
  if (changedExtendedLogging === true) return Date.now() + EXTENDED_LOGGING_TTL_MS;
  if (changedExtendedLogging === false) return null;
  if (extendedLoggingValue && previousUntil !== null && previousUntil <= Date.now()) {
    return Date.now() + EXTENDED_LOGGING_TTL_MS;
  }
  return undefined;
}
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
    colorSchemeValue: settings.colorScheme,
    languageValue: matchSupportedLanguage(settings.language) || 'en',
    interfaceScaleValue: settings.interfaceScale || 100,
    fileListScaleValue: settings.fileListScale || 100,
    terminalFontSizeValue: settings.terminalFontSize || 12,
    dateFormatValue: settings.dateFormat || 'locale',
    defaultLocalPathValue: settings.defaultLocalPath || '',
    showHiddenFilesValue: !!settings.showHiddenFiles,
    coloredTabsValue: settings.coloredTabs !== false,
    minimizeToTrayValue: !!settings.minimizeToTray,
    closeToTrayValue: !!settings.closeToTray,
    showMenuBarIconValue: settings.showMenuBarIcon !== false,
    autoCheckUpdatesValue: settings.autoCheckUpdates !== false,
    autoReconnectTabsValue: !!settings.autoReconnectTabs,
    saveSessionOnExitValue: settings.saveSessionOnExit !== false,
    logEnabledValue: !!settings.logEnabled,
    logShowTimestampsValue: settings.logShowTimestamps !== false,
    logToFileValue: !!settings.logToFile,
    extendedLoggingValue: !!settings.extendedLogging,
    logFolderValue: settings.logFolder || '',
    vaultAutoLockValue: settings.vaultAutoLockMinutes ? String(settings.vaultAutoLockMinutes) : '',
    showSecurityConfirmationsValue: settings.showSecurityConfirmations !== false,
    strictHostKeyCheckValue: settings.strictHostKeyCheck !== false,
  };
}

function draftReducer(state: SettingsDraft, action: DraftAction): SettingsDraft {
  if (action.type === 'reset') return action.draft;
  const previous = state[action.field];
  const next =
    typeof action.value === 'function'
      ? (action.value as (value: typeof previous) => typeof previous)(previous)
      : action.value;
  return { ...state, [action.field]: next };
}

function buildPatch(draft: SettingsDraft): SettingsPatch {
  const concurrency = Math.min(
    MAX_TRANSFER_CONCURRENCY,
    Math.max(0, Number(draft.concurrencyValue) || 0),
  );
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
    colorScheme: draft.colorSchemeValue,
    language: draft.languageValue,
    interfaceScale: Number(draft.interfaceScaleValue),
    fileListScale: Number(draft.fileListScaleValue),
    terminalFontSize: Number(draft.terminalFontSizeValue),
    dateFormat: draft.dateFormatValue,
    defaultLocalPath: draft.defaultLocalPathValue.trim(),
    showHiddenFiles: draft.showHiddenFilesValue,
    coloredTabs: draft.coloredTabsValue,
    minimizeToTray: draft.minimizeToTrayValue,
    closeToTray: draft.closeToTrayValue,
    showMenuBarIcon: draft.showMenuBarIconValue,
    autoCheckUpdates: draft.autoCheckUpdatesValue,
    autoReconnectTabs: draft.autoReconnectTabsValue,
    saveSessionOnExit: draft.saveSessionOnExitValue,
    logEnabled: draft.logEnabledValue,
    logShowTimestamps: draft.logShowTimestampsValue,
    logToFile: draft.logToFileValue,
    extendedLogging: draft.extendedLoggingValue,
    logFolder: draft.logFolderValue.trim(),
    vaultAutoLockMinutes: vaultAutoLock,
    showSecurityConfirmations: draft.showSecurityConfirmationsValue,
    strictHostKeyCheck: draft.strictHostKeyCheckValue,
    keyboardShortcuts: draft.shortcutOverridesValue,
  };
}

/** Settings the store accepts only together: a change to one sends them all. */
const LINKED_SETTINGS: readonly (readonly string[])[] = [
  ['proxyEnabled', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUsername'],
];

/**
 * The part of `patch` that differs from the last saved baseline. Only that is
 * previewed, reverted and saved, so a setting changed elsewhere while the
 * dialog is open, such as from the tray icon's menu, is not put back.
 */
function changedSettings(patch: SettingsPatch, baseline: SettingsPatch): SettingsPatch {
  const changed = new Set(
    Object.keys(patch).filter(
      (key) => JSON.stringify(patch[key]) !== JSON.stringify(baseline[key]),
    ),
  );
  for (const group of LINKED_SETTINGS) {
    if (group.some((key) => changed.has(key))) for (const key of group) changed.add(key);
  }
  return Object.fromEntries(Object.entries(patch).filter(([key]) => changed.has(key)));
}

function pick(patch: SettingsPatch, keys: ReadonlySet<string>): SettingsPatch {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => keys.has(key)));
}

type SettingsDraftSetters = {
  [Key in keyof SettingsDraft as `set${Capitalize<Key>}`]: Dispatch<
    SetStateAction<SettingsDraft[Key]>
  >;
};

export interface SettingsDraftModel extends SettingsDraft, SettingsDraftSetters {
  extendedLoggingUntil: number | null;
  saving: boolean;
  saveError: string | undefined;
  hasUnsavedChanges: boolean;
  confirmCloseArmed: boolean;
  setConfirmCloseArmed: Dispatch<SetStateAction<boolean>>;
  /** True while the backend's confirmation window is up. */
  securityConfirmationPending: boolean;
  changeShowSecurityConfirmationsValue: (next: boolean) => Promise<void>;
  changeStrictHostKeyCheckValue: (next: boolean) => Promise<void>;
  handleSave: (
    vaultBusy: boolean,
    proxyPasswordPatch?: ProxyPasswordPatch,
    saveOptions?: SaveDraftOptions,
  ) => Promise<void>;
  discardChanges: () => void;
  discardAndClose: () => void;
  requestClose: (vaultBusy: boolean, extraUnsavedChanges?: boolean) => void;
}

export function useSettingsDraft(options: UseSettingsDraftOptions): SettingsDraftModel {
  const { onPreview, onSave, onClose, onVaultUnlockRequired, ...initialSettings } = options;
  const [baseline, setBaseline] = useState<{
    draft: SettingsDraft;
    patch: SettingsPatch;
    rawPatch: SettingsPatch;
  }>(() => {
    const initialDraft = createDraft(initialSettings);
    return {
      draft: initialDraft,
      // Normalized through the same rules a save applies, so already-loaded
      // fallback values do not count as unsaved edits.
      patch: buildPatch(initialDraft),
      rawPatch: initialSettings,
    };
  });
  const [draft, dispatch] = useReducer(draftReducer, baseline.draft);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string>();
  const [confirmCloseArmed, setConfirmCloseArmed] = useState(false);
  const [securityConfirmationPending, setSecurityConfirmationPending] = useState(false);
  const securityConfirmationPendingRef = useRef(false);
  const previewedRef = useRef(new Set<string>());

  const currentPatch = buildPatch(draft);
  const hasUnsavedChanges =
    Object.keys(changedSettings(currentPatch, baseline.patch)).length > 0 ||
    JSON.stringify(draft) !== JSON.stringify(baseline.draft);

  const setter =
    <Key extends keyof SettingsDraft>(field: Key): Dispatch<SetStateAction<SettingsDraft[Key]>> =>
    (value) =>
      dispatch({ field, value } as DraftAction);

  useEffect(() => {
    const patch = buildPatch(draft);
    for (const key of Object.keys(changedSettings(patch, baseline.patch))) {
      previewedRef.current.add(key);
    }
    // A setting edited and then put back is previewed once more, which undoes
    // its earlier preview.
    if (previewedRef.current.size > 0) {
      onPreview(pick(patch, previewedRef.current));
    }
    // Preview callbacks intentionally retain the instance captured when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, baseline]);

  /**
   * Turning a protective setting off is confirmed by the backend in a window
   * of its own. It is asked for here, the moment the switch moves, rather
   * than at Save: the user is still looking at the setting they changed, and
   * the window is written in the language the dialog is showing, even when
   * that language is itself an unsaved change.
   *
   * The grant that comes back waits in the settings API until Save, so
   * nothing is turned off before the dialog is saved, and declining simply
   * leaves the switch as it was. One question at a time: the second switch
   * is disabled while the first is being answered.
   */
  const changeProtectedToggle = async (
    field: 'showSecurityConfirmationsValue' | 'strictHostKeyCheckValue',
    key: 'showSecurityConfirmations' | 'strictHostKeyCheck',
    next: boolean,
  ) => {
    if (securityConfirmationPendingRef.current) return;
    if (next) {
      api.settings.releaseSecurityChange();
      dispatch({ field, value: true });
      return;
    }
    securityConfirmationPendingRef.current = true;
    setSecurityConfirmationPending(true);
    try {
      const confirmation = await api.settings.confirmSecurityChange({ [key]: false });
      if (confirmation.ok) dispatch({ field, value: false });
    } finally {
      securityConfirmationPendingRef.current = false;
      setSecurityConfirmationPending(false);
    }
  };
  const changeShowSecurityConfirmationsValue = (next: boolean) =>
    changeProtectedToggle('showSecurityConfirmationsValue', 'showSecurityConfirmations', next);
  const changeStrictHostKeyCheckValue = (next: boolean) =>
    changeProtectedToggle('strictHostKeyCheckValue', 'strictHostKeyCheck', next);

  const handleSave = async (
    vaultBusy: boolean,
    proxyPasswordPatch: ProxyPasswordPatch = {},
    saveOptions: SaveDraftOptions = {},
  ) => {
    if (vaultBusy || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      const patch = buildPatch(draft);
      const changes = changedSettings(patch, baseline.patch);
      const savePatch: SettingsPatch = {
        ...changes,
        ...proxyPasswordPatch,
      };
      const previousUntil =
        typeof baseline.rawPatch.extendedLoggingUntil === 'number'
          ? baseline.rawPatch.extendedLoggingUntil
          : null;
      const untilUpdate = nextExtendedLoggingUntil(
        changes.extendedLogging,
        draft.extendedLoggingValue,
        previousUntil,
      );
      if (untilUpdate !== undefined) {
        savePatch.extendedLoggingUntil = untilUpdate;
      }
      const result = await onSave(savePatch);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        if ('errorCode' in result && result.errorCode === 'cancelled') return;
        if ('errorCode' in result && result.errorCode === 'vaultLocked') {
          onVaultUnlockRequired(() => void handleSave(false, proxyPasswordPatch, saveOptions));
          return;
        }
        // The code goes with it, so the message below is the translated one.
        throw Object.assign(
          new Error('error' in result ? String(result.error) : 'Settings could not be saved'),
          { code: 'errorCode' in result ? result.errorCode : undefined },
        );
      }
      const nextRawPatch = { ...baseline.rawPatch, ...savePatch };
      const savedDraft = createDraft({
        ...baseline.rawPatch,
        ...patch,
      } as SettingsDraftValues);
      previewedRef.current.clear();
      setBaseline({
        draft: savedDraft,
        patch,
        rawPatch: nextRawPatch,
      });
      dispatch({ type: 'reset', draft: savedDraft });
      saveOptions.onSaved?.();
      if (saveOptions.closeAfter) onClose();
    } catch (error) {
      // The user declined a confirmation. They know they did; the dialog stays
      // open with the draft untouched and says nothing further about it.
      if (isCancellation(error)) return;
      // A new proxy password under enhanced protection needs the vault unlocked.
      if (error instanceof CommandFailure && error.code === 'vaultLocked') {
        onVaultUnlockRequired(() => void handleSave(false, proxyPasswordPatch, saveOptions));
        return;
      }
      setSaveError(friendlyError(error instanceof Error ? error : String(error)) || String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const discardChanges = () => {
    if (savingRef.current) return;
    api.settings.releaseSecurityChange();
    const revertPatch = pick(baseline.rawPatch, previewedRef.current);
    previewedRef.current.clear();
    if (Object.keys(revertPatch).length > 0) onPreview(revertPatch);
    dispatch({ type: 'reset', draft: baseline.draft });
    setSaveError(undefined);
  };
  const discardAndClose = () => {
    if (savingRef.current) return;
    discardChanges();
    onClose();
  };
  const requestClose = (vaultBusy: boolean, extraUnsavedChanges = false) => {
    if (vaultBusy || savingRef.current) return;
    if (hasUnsavedChanges || extraUnsavedChanges) {
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
    setColorSchemeValue: setter('colorSchemeValue'),
    setLanguageValue: setter('languageValue'),
    setInterfaceScaleValue: setter('interfaceScaleValue'),
    setFileListScaleValue: setter('fileListScaleValue'),
    setTerminalFontSizeValue: setter('terminalFontSizeValue'),
    setDateFormatValue: setter('dateFormatValue'),
    setDefaultLocalPathValue: setter('defaultLocalPathValue'),
    setShowHiddenFilesValue: setter('showHiddenFilesValue'),
    setColoredTabsValue: setter('coloredTabsValue'),
    setMinimizeToTrayValue: setter('minimizeToTrayValue'),
    setCloseToTrayValue: setter('closeToTrayValue'),
    setShowMenuBarIconValue: setter('showMenuBarIconValue'),
    setAutoCheckUpdatesValue: setter('autoCheckUpdatesValue'),
    setAutoReconnectTabsValue: setter('autoReconnectTabsValue'),
    setSaveSessionOnExitValue: setter('saveSessionOnExitValue'),
    setLogEnabledValue: setter('logEnabledValue'),
    setLogShowTimestampsValue: setter('logShowTimestampsValue'),
    setLogToFileValue: setter('logToFileValue'),
    setExtendedLoggingValue: setter('extendedLoggingValue'),
    setLogFolderValue: setter('logFolderValue'),
    setVaultAutoLockValue: setter('vaultAutoLockValue'),
    setShowSecurityConfirmationsValue: setter('showSecurityConfirmationsValue'),
    setStrictHostKeyCheckValue: setter('strictHostKeyCheckValue'),
    changeStrictHostKeyCheckValue,
    extendedLoggingUntil:
      typeof baseline.rawPatch.extendedLoggingUntil === 'number'
        ? baseline.rawPatch.extendedLoggingUntil
        : null,
    saving,
    saveError,
    hasUnsavedChanges,
    confirmCloseArmed,
    setConfirmCloseArmed,
    securityConfirmationPending,
    changeShowSecurityConfirmationsValue,
    handleSave,
    discardChanges,
    discardAndClose,
    requestClose,
  };
}
