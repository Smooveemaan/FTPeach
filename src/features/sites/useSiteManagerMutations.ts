import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useState } from 'react';
import type { SavedSite, SiteMutationResult } from '../../platform/api/sites.ts';
import type { ManagedSite } from '../../shared/types.ts';
import { createSiteForm, normalizeSiteForm } from './siteForm.ts';
import { findProbableDuplicate } from './siteManagerModel.ts';
import type { SiteManagerDialogState } from './useSiteManagerDialogState.ts';

type DialogController = SiteManagerDialogState & {
  setAddingFolder: Dispatch<SetStateAction<boolean>>;
  setEditingId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setPendingDelete: Dispatch<SetStateAction<SiteManagerDialogState['pendingDelete']>>;
  setRenamingFolderId: Dispatch<SetStateAction<string | null>>;
  setRenamingSiteId: Dispatch<SetStateAction<string | null>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
};

interface UseSiteManagerMutationsOptions {
  canSubmit: boolean;
  dialog: DialogController;
  entries: readonly ManagedSite[];
  isLocalPathManager: boolean;
  readSecrets: () => { password: string; keyPassphrase: string };
  saveFailedMessage: string;
  onSave: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  onDelete: (id: string) => Promise<SiteMutationResult | undefined>;
  onSaveFolder: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  onDeleteFolder: (id: string) => Promise<SiteMutationResult | undefined>;
  onVaultUnlockRequired: (retry: () => void) => void;
  setLocalEntries: Dispatch<SetStateAction<ManagedSite[]>>;
  onFolderDeleted: (id: string) => void;
}

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';

export interface SiteManagerMutationsModel {
  commitAddFolder: () => Promise<void>;
  commitRenameFolder: (folder: ManagedSite) => Promise<void>;
  commitRenameSite: (site: ManagedSite) => Promise<void>;
  handleDelete: () => void;
  handleSubmit: (allowDuplicate?: boolean) => Promise<void>;
  pendingDuplicate: ManagedSite | null;
  setPendingDuplicate: Dispatch<SetStateAction<ManagedSite | null>>;
}

export function useSiteManagerMutations({
  canSubmit,
  dialog,
  entries,
  isLocalPathManager,
  readSecrets,
  saveFailedMessage,
  onSave,
  onDelete,
  onSaveFolder,
  onDeleteFolder,
  onVaultUnlockRequired,
  setLocalEntries,
  onFolderDeleted,
}: UseSiteManagerMutationsOptions): SiteManagerMutationsModel {
  const [pendingDuplicate, setPendingDuplicate] = useState<ManagedSite | null>(null);
  const {
    editingId,
    form,
    newFolderName,
    pendingDelete,
    renameFolderName,
    renameSiteName,
    saving,
    setAddingFolder,
    setEditingId,
    setError,
    setPendingDelete,
    setRenamingFolderId,
    setRenamingSiteId,
    setSaving,
  } = dialog;

  const handleSubmit = useCallback(
    async (allowDuplicate = false) => {
      if (!canSubmit || saving) return;
      const payload = normalizeSiteForm(form, editingId, readSecrets());
      const duplicate = findProbableDuplicate(entries, payload, payload.id);
      if (duplicate && allowDuplicate !== true) {
        setPendingDuplicate(duplicate);
        return;
      }
      setSaving(true);
      setError('');
      try {
        const result = await onSave(payload);
        if (!result?.ok) {
          if (result?.errorCode === 'vaultLocked' || /vault is locked/i.test(result?.error || '')) {
            onVaultUnlockRequired(() => void handleSubmit(allowDuplicate));
            return;
          }
          setError(result?.error || saveFailedMessage);
          return;
        }
        setEditingId(null);
      } catch (cause) {
        setError(causeMessage(cause) || saveFailedMessage);
      } finally {
        setSaving(false);
      }
    },
    [
      editingId,
      entries,
      form,
      canSubmit,
      onSave,
      onVaultUnlockRequired,
      readSecrets,
      saveFailedMessage,
      saving,
      setEditingId,
      setError,
      setSaving,
    ],
  );

  const handleDelete = useCallback(() => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    setError('');
    void (async () => {
      setSaving(true);
      try {
        const result =
          target.kind === 'folder' ? await onDeleteFolder(target.id) : await onDelete(target.id);
        if (result?.ok === false) {
          setError(result.error || saveFailedMessage);
          return;
        }
        if (target.kind === 'folder') {
          onFolderDeleted(target.id);
          setLocalEntries((current) =>
            current
              .map((entry) => (entry.parentId === target.id ? { ...entry, parentId: null } : entry))
              .filter((entry) => entry.id !== target.id),
          );
        } else {
          setLocalEntries((current) => current.filter((entry) => entry.id !== target.id));
        }
      } catch (cause) {
        setError(causeMessage(cause) || saveFailedMessage);
      } finally {
        setSaving(false);
      }
    })();
  }, [
    onDelete,
    onDeleteFolder,
    onFolderDeleted,
    pendingDelete,
    saveFailedMessage,
    setError,
    setLocalEntries,
    setPendingDelete,
    setSaving,
  ]);

  const commitAddFolder = useCallback(async () => {
    if (saving) return;
    const name = newFolderName.trim();
    if (!name) {
      setAddingFolder(false);
      return;
    }
    setSaving(true);
    try {
      const result = await onSaveFolder({
        name,
        parentId: null,
        managerScope: isLocalPathManager ? 'localPaths' : 'bookmarks',
      });
      if (result?.ok === false) {
        setError(result.error || saveFailedMessage);
        return;
      }
      setAddingFolder(false);
      setError('');
    } catch (cause) {
      setError(causeMessage(cause) || saveFailedMessage);
    } finally {
      setSaving(false);
    }
  }, [
    isLocalPathManager,
    newFolderName,
    onSaveFolder,
    saveFailedMessage,
    saving,
    setAddingFolder,
    setError,
    setSaving,
  ]);

  const commitRenameFolder = useCallback(
    async (folder: ManagedSite) => {
      if (saving) return;
      const name = renameFolderName.trim();
      if (!name || name === folder.name) {
        setRenamingFolderId(null);
        return;
      }
      setSaving(true);
      try {
        const result = await onSaveFolder({
          id: folder.id,
          name,
          parentId: folder.parentId ?? null,
          managerScope: isLocalPathManager ? 'localPaths' : 'bookmarks',
        });
        if (result?.ok === false) {
          setError(result.error || saveFailedMessage);
          return;
        }
        setRenamingFolderId(null);
        setError('');
      } catch (cause) {
        setError(causeMessage(cause) || saveFailedMessage);
      } finally {
        setSaving(false);
      }
    },
    [
      isLocalPathManager,
      onSaveFolder,
      renameFolderName,
      saveFailedMessage,
      saving,
      setError,
      setRenamingFolderId,
      setSaving,
    ],
  );

  const commitRenameSite = useCallback(
    async (site: ManagedSite) => {
      if (saving) return;
      const name = renameSiteName.trim();
      if (!name || name === site.name) {
        setRenamingSiteId(null);
        return;
      }
      setSaving(true);
      try {
        const result = await onSave(normalizeSiteForm({ ...createSiteForm(site), name }, site.id));
        if (result?.ok === false) {
          setError(result.error || saveFailedMessage);
          return;
        }
        setRenamingSiteId(null);
        setError('');
      } catch (cause) {
        setError(causeMessage(cause) || saveFailedMessage);
      } finally {
        setSaving(false);
      }
    },
    [onSave, renameSiteName, saveFailedMessage, saving, setError, setRenamingSiteId, setSaving],
  );

  return {
    commitAddFolder,
    commitRenameFolder,
    commitRenameSite,
    handleDelete,
    handleSubmit,
    pendingDuplicate,
    setPendingDuplicate,
  };
}
