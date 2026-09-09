import { useCallback, useMemo, useReducer, useRef } from 'react';
import type { MenuItem } from '../components/MenuItems.tsx';
import type { FileEntry, PaneId, SiteForm } from '../shared/types.ts';

interface ConfirmState {
  message: string;
  onConfirm: () => unknown;
  onCancel?: (() => unknown) | undefined;
  confirmLabel?: string | undefined;
  danger?: boolean | undefined;
}
export interface MoveToTarget {
  id: PaneId;
  names: string[];
  folders: string[];
}
export interface ChmodTarget {
  id: PaneId;
  entry: FileEntry;
  mode: string;
}
export interface DriveMenu {
  id: PaneId;
  x: number;
  y: number;
  items: MenuItem[];
}
export interface DialogState {
  showSettings: boolean;
  showAbout: boolean;
  showSaveSite: SiteForm | false;
  showSiteManagerDialog: PaneId | true | false;
  showLocalPathManagerDialog: PaneId | true | false;
  showExportSettings: boolean;
  showImportSettings: boolean;
  newFolderTarget: PaneId | null;
  newFileTarget: PaneId | null;
  moveToTarget: MoveToTarget | null;
  chmodTarget: ChmodTarget | null;
  driveMenu: DriveMenu | null;
  confirmState: ConfirmState | null;
  vaultUnlockRetries: Array<() => unknown>;
}
type DialogValue<K extends keyof DialogState> =
  DialogState[K] | ((previous: DialogState[K]) => DialogState[K]);
type DialogAction = {
  [K in keyof DialogState]: { type: 'set'; name: K; value: DialogValue<K> };
}[keyof DialogState];
type DialogSetters = {
  [K in keyof DialogState as `set${Capitalize<string & K>}`]: (value: DialogValue<K>) => void;
};

export const INITIAL_DIALOG_STATE: DialogState = {
  showSettings: false,
  showAbout: false,
  showSaveSite: false,
  showSiteManagerDialog: false,
  showLocalPathManagerDialog: false,
  showExportSettings: false,
  showImportSettings: false,
  newFolderTarget: null,
  newFileTarget: null,
  moveToTarget: null,
  chmodTarget: null,
  driveMenu: null,
  confirmState: null,
  vaultUnlockRetries: [],
};

export function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  const value =
    typeof action.value === 'function'
      ? (action.value as (previous: DialogState[keyof DialogState]) => unknown)(state[action.name])
      : action.value;
  return { ...state, [action.name]: value };
}

export interface AppDialogs extends DialogState, DialogSetters {
  requestConfirm: (
    message: string,
    onConfirm: () => unknown,
    options?: { confirmLabel?: string; danger?: boolean; onCancel?: () => unknown },
  ) => void;
}

export function useAppDialogs(): AppDialogs {
  const pendingCancel = useRef<(() => unknown) | undefined>(undefined);
  const [state, dispatch] = useReducer(dialogReducer, INITIAL_DIALOG_STATE);
  const setters = useMemo<DialogSetters>(
    () =>
      Object.fromEntries(
        Object.keys(INITIAL_DIALOG_STATE).map((name) => [
          `set${name.slice(0, 1).toUpperCase()}${name.slice(1)}`,
          (value: unknown) => dispatch({ type: 'set', name, value } as DialogAction),
        ]),
      ) as DialogSetters,
    [],
  );
  const requestConfirm = useCallback(
    (
      message: string,
      onConfirm: () => unknown,
      {
        confirmLabel,
        danger,
        onCancel,
      }: { confirmLabel?: string; danger?: boolean; onCancel?: () => unknown } = {},
    ) => {
      pendingCancel.current?.();
      pendingCancel.current = onCancel;
      dispatch({
        type: 'set',
        name: 'confirmState',
        value: { message, onConfirm, onCancel, confirmLabel, danger },
      });
    },
    [],
  );

  return { ...state, ...setters, requestConfirm };
}
