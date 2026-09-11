import { useCallback, useMemo, useReducer } from 'react';

import { api } from '../../platform/api/index.ts';
import type { AppSettings, SettingsSetResult } from '../../platform/api/settings.ts';
import SETTINGS_DEFAULTS from '../../shared/settingsDefaults.ts';
import { isValidBinding } from '../../shortcuts/bindings.ts';
import { SHORTCUT_ACTIONS } from '../../shortcuts/registry.ts';

export type PaneColumns = Record<'a' | 'b', string[]>;
export type ColumnWidths = Record<string, number>;
export type PaneColumnWidths = Record<'a' | 'b', ColumnWidths>;
export type ShortcutOverrides = Record<string, string>;
export type PaneOrientation = 'horizontal' | 'vertical';
export type OverwriteAction = 'ask' | 'skip' | 'overwrite';

/**
 * One field per persisted setting, flat, exactly as the backend stores them
 * and as a settings patch names them. The renderer holds these grouped by
 * owner (see {@link SETTING_GROUPS}); this is the vocabulary the groups are
 * built from and the shape a patch travels in.
 */
export interface SettingsValues {
  theme: string;
  language: string;
  interfaceScale: number;
  dateFormat: string;
  defaultLocalPath: string;
  concurrency: number;
  connectTimeout: number;
  notifyOnTransferComplete: boolean;
  overwriteAction: OverwriteAction;
  ftpActiveMode: boolean;
  proxyEnabled: boolean;
  proxyType: string;
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPasswordSet: boolean;
  preventSleepDuringTransfers: boolean;
  transferSpeedLimitKBps: number;
  openWithAssociations: Record<string, string>;
  autoCheckUpdates: boolean;
  autoReconnectTabs: boolean;
  saveSessionOnExit: boolean;
  vaultAutoLockMinutes: number;
  showSecurityConfirmations: boolean;
  localColumns: PaneColumns;
  remoteColumns: PaneColumns;
  localColumnWidths: PaneColumnWidths;
  remoteColumnWidths: PaneColumnWidths;
  transferColumnWidths: ColumnWidths;
  transferHiddenColumns: string[];
  transferColumnOrder: string[];
  showLocalPane: boolean;
  showRemotePane: boolean;
  showTransferQueue: boolean;
  showHiddenFiles: boolean;
  coloredTabs: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  paneOrientation: PaneOrientation;
  logEnabled: boolean;
  logShowTimestamps: boolean;
  logToFile: boolean;
  keyboardShortcuts: ShortcutOverrides;
}

/**
 * Which owner each setting belongs to.
 *
 * The state used to be one flat object of ~45 fields, so every consumer was
 * flat too: `Application.tsx` destructured 45 names out of `useSettings()` by
 * hand to hand them on in ones and twos. Grouping means a consumer takes the
 * one group it is about — `useWorkspaceLayout` takes `layout`, `useAppEffects`
 * takes `interface` — and adding a setting touches only its group.
 *
 * The groups are the settings dialog's own sections, plus `layout` for the
 * persisted geometry the dialog never shows (pane visibility, column widths
 * and order, orientation), which the workspace and the layout reset own.
 */
export const SETTING_GROUPS = {
  interface: [
    'theme',
    'language',
    'interfaceScale',
    'dateFormat',
    'defaultLocalPath',
    'coloredTabs',
    'minimizeToTray',
    'closeToTray',
  ],
  layout: [
    'localColumns',
    'remoteColumns',
    'localColumnWidths',
    'remoteColumnWidths',
    'transferColumnWidths',
    'transferColumnOrder',
    'transferHiddenColumns',
    'showLocalPane',
    'showRemotePane',
    'showTransferQueue',
    'showHiddenFiles',
    'paneOrientation',
  ],
  connection: [
    'connectTimeout',
    'ftpActiveMode',
    'proxyEnabled',
    'proxyType',
    'proxyHost',
    'proxyPort',
    'proxyUsername',
    'proxyPasswordSet',
    'autoReconnectTabs',
    'saveSessionOnExit',
  ],
  transfers: [
    'concurrency',
    'notifyOnTransferComplete',
    'overwriteAction',
    'preventSleepDuringTransfers',
    'transferSpeedLimitKBps',
    'openWithAssociations',
  ],
  updates: ['autoCheckUpdates'],
  security: ['vaultAutoLockMinutes', 'showSecurityConfirmations'],
  logging: ['logEnabled', 'logShowTimestamps', 'logToFile'],
  shortcuts: ['keyboardShortcuts'],
} as const satisfies Record<string, readonly (keyof SettingsValues)[]>;

export type SettingsGroupName = keyof typeof SETTING_GROUPS;

/** The settings state as consumers see it: one object per owner. */
export type SettingsState = {
  [Group in SettingsGroupName]: {
    [Name in (typeof SETTING_GROUPS)[Group][number]]: SettingsValues[Name];
  };
};

export type SettingsUpdaters = {
  [Group in SettingsGroupName]: (
    patch:
      | Partial<SettingsState[Group]>
      | ((previous: SettingsState[Group]) => Partial<SettingsState[Group]>),
  ) => void;
};

const GROUP_NAMES = Object.keys(SETTING_GROUPS) as SettingsGroupName[];
const SETTING_NAMES = GROUP_NAMES.flatMap(
  (group) => SETTING_GROUPS[group] as readonly (keyof SettingsValues)[],
);

/** Which group owns each setting, for distributing a flat patch. */
const GROUP_OF = new Map<keyof SettingsValues, SettingsGroupName>(
  GROUP_NAMES.flatMap((group) =>
    (SETTING_GROUPS[group] as readonly (keyof SettingsValues)[]).map(
      (name) => [name, group] as const,
    ),
  ),
);

/**
 * Splits the flat values into groups.
 *
 * `SETTING_GROUPS` is what makes the mapped type above and this loop agree,
 * and TypeScript cannot follow that through `Object.fromEntries` — hence the
 * cast here and its mirror in {@link settingsValues}. They are the only two.
 */
function groupValues(values: SettingsValues): SettingsState {
  return Object.fromEntries(
    GROUP_NAMES.map((group) => [
      group,
      Object.fromEntries(
        (SETTING_GROUPS[group] as readonly (keyof SettingsValues)[]).map((name) => [
          name,
          values[name],
        ]),
      ),
    ]),
  ) as SettingsState;
}

/** Flattens the groups back, for the settings dialog, which shows them all. */
export function settingsValues(state: SettingsState): SettingsValues {
  const values: Record<string, unknown> = {};
  for (const group of GROUP_NAMES) Object.assign(values, state[group]);
  return values as unknown as SettingsValues;
}

export type SettingsPatch = Record<string, unknown>;
type SettingsApi = { set: (patch: SettingsPatch) => Promise<SettingsSetResult> };
type LogApi = {
  setFileLogging: (enabled: boolean | undefined) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeColumnsSetting(value: unknown, fallback: PaneColumns): PaneColumns {
  if (Array.isArray(value)) return { a: value as string[], b: value as string[] };
  if (isRecord(value)) {
    return {
      a: Array.isArray(value.a) ? (value.a as string[]) : fallback.a,
      b: Array.isArray(value.b) ? (value.b as string[]) : fallback.b,
    };
  }
  return fallback;
}

export function normalizeWidthsSetting(
  value: unknown,
  fallback: PaneColumnWidths,
): PaneColumnWidths {
  if (isRecord(value)) {
    if (isRecord(value.a) && isRecord(value.b)) {
      return { a: value.a as ColumnWidths, b: value.b as ColumnWidths };
    }
    return { a: value as ColumnWidths, b: value as ColumnWidths };
  }
  return fallback;
}

export function normalizeStringArraySetting(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : fallback;
}

export function normalizeKeyboardShortcuts(value: unknown): ShortcutOverrides {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([actionId, binding]) =>
        SHORTCUT_ACTIONS.some((action) => action.id === actionId) &&
        (binding === '' || isValidBinding(binding)),
    ),
  ) as ShortcutOverrides;
}

function normalizeValues(settings: AppSettings): SettingsValues {
  const s = settings;
  const stringSetting = (value: unknown, fallback: string) =>
    typeof value === 'string' && value ? value : fallback;
  const proxyHost = stringSetting(s.proxyHost, SETTINGS_DEFAULTS.proxyHost);
  const proxyPort = typeof s.proxyPort === 'number' ? s.proxyPort : SETTINGS_DEFAULTS.proxyPort;
  const overwriteAction: OverwriteAction = ['ask', 'skip', 'overwrite'].includes(
    String(s.overwriteAction),
  )
    ? (s.overwriteAction as OverwriteAction)
    : (SETTINGS_DEFAULTS.overwriteAction as OverwriteAction);
  const paneOrientation: PaneOrientation =
    s.paneOrientation === 'horizontal' || s.paneOrientation === 'vertical'
      ? s.paneOrientation
      : (SETTINGS_DEFAULTS.paneOrientation as PaneOrientation);
  return {
    theme: stringSetting(s.theme, SETTINGS_DEFAULTS.theme),
    language: stringSetting(s.language, SETTINGS_DEFAULTS.language),
    interfaceScale:
      typeof s.interfaceScale === 'number'
        ? Math.min(150, Math.max(80, s.interfaceScale))
        : SETTINGS_DEFAULTS.interfaceScale,
    dateFormat: stringSetting(s.dateFormat, SETTINGS_DEFAULTS.dateFormat),
    defaultLocalPath: stringSetting(s.defaultLocalPath, SETTINGS_DEFAULTS.defaultLocalPath),
    concurrency: typeof s.concurrency === 'number' ? s.concurrency : SETTINGS_DEFAULTS.concurrency,
    connectTimeout:
      typeof s.connectTimeout === 'number' ? s.connectTimeout : SETTINGS_DEFAULTS.connectTimeout,
    notifyOnTransferComplete: s.notifyOnTransferComplete !== false,
    overwriteAction,
    ftpActiveMode: !!s.ftpActiveMode,
    // Recover from legacy/incomplete settings which allowed the proxy toggle
    // to be persisted without an address and consequently blocked all protocols.
    proxyEnabled: !!s.proxyEnabled && !!proxyHost.trim() && proxyPort >= 1 && proxyPort <= 65535,
    proxyType: stringSetting(s.proxyType, SETTINGS_DEFAULTS.proxyType),
    proxyHost,
    proxyPort,
    proxyUsername: stringSetting(s.proxyUsername, SETTINGS_DEFAULTS.proxyUsername),
    proxyPasswordSet: !!s.proxyPasswordSet,
    preventSleepDuringTransfers: s.preventSleepDuringTransfers !== false,
    transferSpeedLimitKBps:
      typeof s.transferSpeedLimitKBps === 'number'
        ? s.transferSpeedLimitKBps
        : SETTINGS_DEFAULTS.transferSpeedLimitKBps,
    openWithAssociations:
      s.openWithAssociations && isRecord(s.openWithAssociations)
        ? (Object.fromEntries(
            Object.entries(s.openWithAssociations).filter(
              ([extension, application]) =>
                /^[a-z0-9][a-z0-9_-]*$/i.test(extension) &&
                typeof application === 'string' &&
                application,
            ),
          ) as Record<string, string>)
        : {},
    autoCheckUpdates: s.autoCheckUpdates !== false,
    autoReconnectTabs: !!s.autoReconnectTabs,
    saveSessionOnExit: s.saveSessionOnExit !== false,
    vaultAutoLockMinutes:
      typeof s.vaultAutoLockMinutes === 'number'
        ? s.vaultAutoLockMinutes
        : SETTINGS_DEFAULTS.vaultAutoLockMinutes,
    showSecurityConfirmations: s.showSecurityConfirmations !== false,
    localColumns: normalizeColumnsSetting(s.localColumns, SETTINGS_DEFAULTS.localColumns),
    remoteColumns: normalizeColumnsSetting(s.remoteColumns, SETTINGS_DEFAULTS.remoteColumns),
    localColumnWidths: normalizeWidthsSetting(
      s.localColumnWidths,
      SETTINGS_DEFAULTS.localColumnWidths,
    ),
    remoteColumnWidths: normalizeWidthsSetting(
      s.remoteColumnWidths,
      SETTINGS_DEFAULTS.remoteColumnWidths,
    ),
    transferColumnWidths: isRecord(s.transferColumnWidths)
      ? (s.transferColumnWidths as ColumnWidths)
      : SETTINGS_DEFAULTS.transferColumnWidths,
    transferHiddenColumns: normalizeStringArraySetting(
      s.transferHiddenColumns,
      SETTINGS_DEFAULTS.transferHiddenColumns,
    ),
    transferColumnOrder: normalizeStringArraySetting(
      s.transferColumnOrder,
      SETTINGS_DEFAULTS.transferColumnOrder,
    ),
    showLocalPane: s.showLocalPane !== false,
    showRemotePane: s.showRemotePane !== false,
    showTransferQueue: s.showTransferQueue !== false,
    showHiddenFiles: !!s.showHiddenFiles,
    coloredTabs: s.coloredTabs !== false,
    minimizeToTray: !!s.minimizeToTray,
    closeToTray: !!s.closeToTray,
    paneOrientation,
    logEnabled: !!s.logEnabled,
    logShowTimestamps: s.logShowTimestamps !== false,
    logToFile: !!s.logToFile,
    keyboardShortcuts: normalizeKeyboardShortcuts(s.keyboardShortcuts),
  };
}

/** Reads the persisted settings into the grouped state consumers hold. */
export function normalizeSettings(settings: AppSettings): SettingsState {
  return groupValues(normalizeValues(settings));
}

const INITIAL_STATE = normalizeSettings(SETTINGS_DEFAULTS);

type SettingsAction =
  | { type: 'hydrate'; settings: AppSettings }
  | { type: 'patch'; patch: SettingsPatch }
  | { type: 'update'; group: SettingsGroupName; patch: unknown };

/**
 * Distributes a flat patch into the groups that own its keys.
 *
 * Written against a `Record` view of the state because the group index is
 * only known at runtime, and a union-typed index would make every assignment
 * an intersection of all eight groups.
 */
function applyFlatPatch(state: SettingsState, patch: SettingsPatch): SettingsState {
  const next: Record<string, Record<string, unknown>> = {
    ...(state as unknown as Record<string, Record<string, unknown>>),
  };
  let changed = false;
  for (const [name, value] of Object.entries(patch)) {
    const group = GROUP_OF.get(name as keyof SettingsValues);
    if (group === undefined) continue;
    next[group] = { ...next[group], [name]: value };
    changed = true;
  }
  return changed ? (next as unknown as SettingsState) : state;
}

function reducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case 'hydrate':
      return normalizeSettings(action.settings);
    case 'patch':
      return applyFlatPatch(state, action.patch);
    case 'update': {
      const previous = state[action.group];
      const patch =
        typeof action.patch === 'function'
          ? (action.patch as (previous: unknown) => object)(previous)
          : (action.patch as object);
      return { ...state, [action.group]: { ...previous, ...patch } };
    }
  }
}

export interface SettingsModel {
  settings: SettingsState;
  update: SettingsUpdaters;
  applySettings: (settings: AppSettings) => void;
  applySettingsDialogPatch: (patch: SettingsPatch) => void;
  persistSettingsDialogPatch: (patch: SettingsPatch) => Promise<void>;
}

export function useSettings({
  settingsApi = api.settings,
  logApi = api.log,
}: { settingsApi?: SettingsApi; logApi?: LogApi } = {}): SettingsModel {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // One updater per group, so a consumer that owns a group can change any
  // number of its fields at once and never sees the other groups.
  const update = useMemo(
    () =>
      Object.fromEntries(
        GROUP_NAMES.map((group) => [
          group,
          (patch: unknown) => dispatch({ type: 'update', group, patch }),
        ]),
      ) as SettingsUpdaters,
    [],
  );

  const applySettings = useCallback(
    (settings: AppSettings) => {
      dispatch({ type: 'hydrate', settings });
      if (settings.logToFile) logApi.setFileLogging(true);
    },
    [logApi],
  );

  const applySettingsDialogPatch = useCallback(
    (patch: SettingsPatch) => {
      const livePatch = Object.fromEntries(
        Object.entries(patch).filter(
          ([name]) =>
            SETTING_NAMES.includes(name as keyof SettingsValues) && name !== 'proxyPasswordSet',
        ),
      );
      dispatch({ type: 'patch', patch: livePatch });
      if (typeof patch.logToFile === 'boolean') logApi.setFileLogging(patch.logToFile);
    },
    [logApi],
  );

  const persistSettingsDialogPatch = useCallback(
    (patch: SettingsPatch) =>
      settingsApi.set(patch).then((next) => {
        if (next.ok === false) throw new Error(String(next.error || 'Settings could not be saved'));
        dispatch({ type: 'patch', patch: { proxyPasswordSet: !!next.proxyPasswordSet } });
      }),
    [settingsApi],
  );

  return {
    settings: state,
    update,
    applySettings,
    applySettingsDialogPatch,
    persistSettingsDialogPatch,
  };
}
