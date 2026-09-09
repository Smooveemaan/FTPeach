import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useMemo, useReducer } from 'react';
import type { SiteForm } from '../../shared/types.ts';
import { createSiteForm } from './siteForm.ts';

export interface SiteDeleteTarget {
  kind: 'site' | 'folder';
  id: string;
  name: string;
}

export interface SiteManagerDialogState {
  editingId: string | null;
  form: SiteForm;
  error: string;
  saving: boolean;
  pendingDelete: SiteDeleteTarget | null;
  addingFolder: boolean;
  newFolderName: string;
  renamingFolderId: string | null;
  renameFolderName: string;
  renamingSiteId: string | null;
  renameSiteName: string;
}

type SiteManagerDialogAction =
  | { type: 'patch'; value: Partial<SiteManagerDialogState> }
  | { type: 'set'; key: keyof SiteManagerDialogState; value: unknown };

type SiteManagerSetters = {
  [Key in keyof SiteManagerDialogState as `set${Capitalize<Key>}`]: Dispatch<
    SetStateAction<SiteManagerDialogState[Key]>
  >;
};

const initialState = (form?: SiteForm): SiteManagerDialogState => ({
  editingId: form ? '__new__' : null,
  form: form ? { ...form, password: '', keyPassphrase: '' } : createSiteForm(),
  error: '',
  saving: false,
  pendingDelete: null,
  addingFolder: false,
  newFolderName: '',
  renamingFolderId: null,
  renameFolderName: '',
  renamingSiteId: null,
  renameSiteName: '',
});

export function siteManagerDialogReducer(
  state: SiteManagerDialogState,
  action: SiteManagerDialogAction,
): SiteManagerDialogState {
  if (action.type === 'patch') return { ...state, ...action.value };
  const value =
    typeof action.value === 'function'
      ? (
          action.value as (
            previous: SiteManagerDialogState[keyof SiteManagerDialogState],
          ) => unknown
        )(state[action.key])
      : action.value;
  return { ...state, [action.key]: value };
}

export interface SiteManagerDialogModel extends SiteManagerDialogState, SiteManagerSetters {
  patch: (value: Partial<SiteManagerDialogState>) => void;
}

export function useSiteManagerDialogState(initialForm?: SiteForm): SiteManagerDialogModel {
  const [state, dispatch] = useReducer(siteManagerDialogReducer, initialForm, initialState);
  const set = useCallback(
    <Key extends keyof SiteManagerDialogState>(key: Key) =>
      (value: SetStateAction<SiteManagerDialogState[Key]>) =>
        dispatch({ type: 'set', key, value }),
    [],
  );
  const patch = useCallback(
    (value: Partial<SiteManagerDialogState>) => dispatch({ type: 'patch', value }),
    [],
  );
  const setters = useMemo(
    () => ({
      setAddingFolder: set('addingFolder'),
      setEditingId: set('editingId'),
      setError: set('error'),
      setForm: set('form'),
      setNewFolderName: set('newFolderName'),
      setPendingDelete: set('pendingDelete'),
      setRenameFolderName: set('renameFolderName'),
      setRenamingFolderId: set('renamingFolderId'),
      setRenameSiteName: set('renameSiteName'),
      setRenamingSiteId: set('renamingSiteId'),
      setSaving: set('saving'),
    }),
    [set],
  );

  return {
    ...state,
    patch,
    ...setters,
  };
}
