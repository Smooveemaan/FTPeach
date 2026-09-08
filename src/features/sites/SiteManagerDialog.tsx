import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from '../../components/Modal.tsx';
import ConfirmDialog from '../../components/ConfirmDialog.tsx';
import { isolate } from '../../shared/bidi.ts';
import ExportSettingsDialog from '../../components/ExportSettingsDialog.tsx';
import type { ExportSettingsOptions } from '../../components/ExportSettingsDialog.tsx';
import ImportSettingsDialog from '../../components/ImportSettingsDialog.tsx';
import type { ImportSettingsOptions } from '../../components/ImportSettingsDialog.tsx';
import Icon from '../../components/Icon.tsx';
import { canSubmitSiteForm, createSiteForm, DEFAULT_SITE_PORTS } from './siteForm.ts';
import SiteEditor from './SiteEditor.tsx';
import DismissibleError from '../../components/DismissibleError.tsx';
import type { SiteTextField } from './SiteEditor.tsx';
import SiteSearchResults from './SiteSearchResults.tsx';
import SortModeSelect from './SortModeSelect.tsx';
import SiteTree from './SiteTree.tsx';
import { useSiteDragController } from './useSiteDragController.ts';
import { useSiteManagerDialogState } from './useSiteManagerDialogState.ts';
import { useSiteManagerMutations } from './useSiteManagerMutations.ts';
import { useSiteSearch } from './useSiteSearch.ts';
import { useSiteSecrets } from './useSiteSecrets.ts';
import { useTruncated } from '../../hooks/useTruncated.ts';
import { entriesForManager, sortManagedEntries } from './siteManagerModel.ts';
import type { SiteManagerKind, SiteSortMode } from './siteManagerModel.ts';
import type { ManagedSite, SiteProtocol, Translate } from '../../shared/types.ts';
import type { SavedSite, SiteLayout, SiteMutationResult } from '../../platform/api/sites.ts';
import { handler } from '../../shared/asyncFailure.ts';
import { api } from '../../platform/api/index.ts';

interface ImportSummary {
  sitesAdded: number;
  sitesSkipped: number;
}

export interface SiteManagerDialogProps {
  managerKind?: SiteManagerKind;
  entries: ManagedSite[];
  onSave: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  onDelete: (id: string) => Promise<SiteMutationResult | undefined>;
  onApplyLayout: (layout: SiteLayout) => Promise<SiteMutationResult | undefined>;
  onSaveFolder: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  onDeleteFolder: (id: string) => Promise<SiteMutationResult | undefined>;
  onImport: (options: ImportSettingsOptions) => Promise<ImportSummary | undefined>;
  onExport: (options: ExportSettingsOptions) => Promise<boolean | undefined>;
  onConnect: (site: ManagedSite) => void;
  onVaultUnlockRequired: (retry: () => void) => void;
  onClose: () => void;
}

type TransferStatus = { kind: 'import'; added: number; skipped: number } | { kind: 'export' };

function siteManagerFooterMessage(status: TransferStatus, t: Translate): string {
  if (status.kind === 'export') return t('siteManagerDialog.exportSuccess');
  if (status.added === 0 && status.skipped === 0) return t('siteManagerDialog.importNothingNew');
  return [
    t('siteManagerDialog.importAdded', { count: status.added }),
    status.skipped > 0 ? t('siteManagerDialog.importSkipped', { count: status.skipped }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const collapsedFolderIds = new Set<string>();
const forgetCollapsedFolder = (id: string) => collapsedFolderIds.delete(id);
const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';

export default function SiteManagerDialog({
  managerKind = 'bookmarks',
  entries,
  onSave,
  onDelete,
  onApplyLayout,
  onSaveFolder,
  onDeleteFolder,
  onImport,
  onExport,
  onConnect,
  onVaultUnlockRequired,
  onClose,
}: SiteManagerDialogProps) {
  const { t } = useTranslation();
  const isLocalPathManager = managerKind === 'localPaths';
  const managedEntries = useMemo(
    () => entriesForManager(entries, managerKind),
    [entries, managerKind],
  );
  const [expandedFolderIds, setExpandedFolderIds] = useState(() => {
    const folderIds = managedEntries.filter((e) => e.kind === 'folder').map((e) => e.id);
    return new Set(folderIds.filter((id) => !collapsedFolderIds.has(id)));
  });
  useEffect(() => {
    const folderIds = managedEntries.filter((e) => e.kind === 'folder').map((e) => e.id);
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of folderIds) {
        if (!next.has(id) && !collapsedFolderIds.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [managedEntries]);

  const [sortMode, setSortMode] = useState<SiteSortMode>('manual');
  const [rsaKeySelected, setRsaKeySelected] = useState(false);
  const [transferStatus, setTransferStatus] = useState<TransferStatus | null>(null);
  const footerMessage = transferStatus ? siteManagerFooterMessage(transferStatus, t) : null;
  const [footerRef, footerTruncated] = useTruncated<HTMLDivElement>([footerMessage]);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showImportOptions, setShowImportOptions] = useState(false);
  const displayEntries = useMemo(
    () => sortManagedEntries(managedEntries, sortMode),
    [managedEntries, sortMode],
  );
  const dialog = useSiteManagerDialogState();
  const {
    addingFolder,
    editingId,
    error,
    form,
    newFolderName,
    pendingDelete,
    patch,
    renameFolderName,
    renamingFolderId,
    renameSiteName,
    renamingSiteId,
    saving,
    setAddingFolder,
    setError,
    setForm,
    setNewFolderName,
    setPendingDelete,
    setRenameFolderName,
    setRenamingFolderId,
    setRenameSiteName,
    setRenamingSiteId,
  } = dialog;

  const { keyPassphraseRef, passwordRef, readSecrets, resetSecrets, revealSavedSecret } =
    useSiteSecrets({
      editingId,
      revealFailedMessage: t('siteManagerDialog.revealFailed'),
      setError,
    });

  const {
    activeEntry,
    activeId,
    activeRect,
    canCollapseSource,
    collisionDetection,
    containers,
    dragContentHeight,
    dropTargetFolderId,
    entriesById,
    handleDragCancel,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    localEntries,
    modifiers,
    moveEntryBy,
    registerRowNode,
    sensors,
    setLocalEntries,
  } = useSiteDragController({
    entries: displayEntries,
    onApplyLayout,
    onCommitError: (message) => setError(message || t('siteManagerDialog.saveFailed')),
  });

  const {
    closeSearch,
    filteredSites,
    isSearching,
    searchInputRef,
    searchOpen,
    searchQuery,
    setSearchOpen,
    setSearchQuery,
  } = useSiteSearch({ entries: localEntries, entriesById });

  const canSubmit = canSubmitSiteForm(form);

  const startEdit = (site: ManagedSite) => {
    setRsaKeySelected(false);
    resetSecrets();
    patch({
      addingFolder: false,
      editingId: site.id,
      error: '',
      form: createSiteForm(site),
      renamingFolderId: null,
      renamingSiteId: null,
    });
  };

  const startAdd = (parentId: string | null = null) => {
    setRsaKeySelected(false);
    resetSecrets();
    patch({
      addingFolder: false,
      editingId: '__new__',
      error: '',
      form: { ...createSiteForm(), parentId },
      renamingFolderId: null,
      renamingSiteId: null,
    });
  };

  const startAddLocal = (parentId: string | null = null) => {
    setRsaKeySelected(false);
    resetSecrets();
    patch({
      addingFolder: false,
      editingId: '__new__',
      error: '',
      form: { ...createSiteForm(), kind: 'local', icon: 'folder', parentId },
      renamingFolderId: null,
      renamingSiteId: null,
    });
  };

  const duplicateSite = (site: ManagedSite) => {
    setRsaKeySelected(false);
    resetSecrets();
    patch({
      addingFolder: false,
      editingId: '__new__',
      error: '',
      form: {
        ...createSiteForm(site),
        name: `${site.name}${t('siteManagerDialog.duplicateNameSuffix')}`,
        hasPassword: false,
        hasKeyPassphrase: false,
      },
      renamingFolderId: null,
      renamingSiteId: null,
    });
  };

  const cancelEdit = () => {
    if (saving) return;
    setRsaKeySelected(false);
    patch({ editingId: null, error: '', saving: false });
  };

  const handleField = (key: SiteTextField) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleProtocolChange = (protocol: SiteProtocol) => {
    const prevDefault = DEFAULT_SITE_PORTS[form.protocol];
    const nextPort = form.port === prevDefault ? DEFAULT_SITE_PORTS[protocol] || '' : form.port;
    setForm((f) => ({ ...f, protocol, port: nextPort }));
  };

  const chooseKeyFile = async () => {
    try {
      const selected = await api.fsLocal.selectKeyFile();
      if (selected) {
        setRsaKeySelected(selected.isRsa);
        setForm((f) => ({ ...f, keyPath: selected.path }));
      }
    } catch (cause) {
      setError(errorMessage(cause) || t('siteManagerDialog.saveFailed'));
    }
  };

  const chooseCaCertFile = async () => {
    try {
      const selected = await api.fsLocal.selectCaCertFile();
      if (selected) setForm((f) => ({ ...f, caCertPath: selected }));
    } catch (cause) {
      setError(errorMessage(cause) || t('siteManagerDialog.saveFailed'));
    }
  };

  const chooseLocalPath = async () => {
    try {
      const selected = await api.fsLocal.selectDir();
      if (selected) {
        const suggestedName = selected.split(/[\\/]/).filter(Boolean).at(-1) || selected;
        setForm((current) => ({
          ...current,
          localPath: selected,
          name: current.name.trim() ? current.name : suggestedName,
        }));
      }
    } catch (cause) {
      setError(errorMessage(cause) || t('siteManagerDialog.saveFailed'));
    }
  };

  const {
    commitAddFolder,
    commitRenameFolder,
    commitRenameSite,
    handleDelete,
    handleSubmit,
    pendingDuplicate,
    setPendingDuplicate,
  } = useSiteManagerMutations({
    canSubmit,
    dialog,
    entries: managedEntries,
    isLocalPathManager,
    readSecrets,
    saveFailedMessage: t('siteManagerDialog.saveFailed'),
    onSave,
    onDelete,
    onSaveFolder,
    onDeleteFolder,
    onVaultUnlockRequired,
    setLocalEntries,
    onFolderDeleted: forgetCollapsedFolder,
  });

  const handleImportConfirm = async (options: ImportSettingsOptions) => {
    const summary = await onImport(options);
    if (summary)
      setTransferStatus({
        kind: 'import',
        added: summary.sitesAdded,
        skipped: summary.sitesSkipped,
      });
  };

  const handleExportConfirm = async (options: ExportSettingsOptions) => {
    const ok = await onExport(options);
    if (ok) setTransferStatus({ kind: 'export' });
  };

  const toggleFolder = (id: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        collapsedFolderIds.add(id);
      } else {
        next.add(id);
        collapsedFolderIds.delete(id);
      }
      return next;
    });
  };

  const startAddFolder = () => {
    // The inline new-folder row only renders inside SiteTree, not the flat
    // search results — clear an active search so it's actually visible.
    setSearchQuery('');
    patch({
      addingFolder: true,
      error: '',
      newFolderName: '',
      renamingFolderId: null,
      renamingSiteId: null,
    });
  };

  const startRenameFolder = (folder: ManagedSite) => {
    patch({
      addingFolder: false,
      error: '',
      renameFolderName: folder.name,
      renamingFolderId: folder.id,
      renamingSiteId: null,
    });
  };

  const startRenameSite = (site: ManagedSite) => {
    patch({
      addingFolder: false,
      error: '',
      renameSiteName: site.name,
      renamingFolderId: null,
      renamingSiteId: site.id,
    });
  };

  const editing = editingId != null;

  return (
    <>
      <Modal
        title={
          editing
            ? isLocalPathManager
              ? editingId === '__new__'
                ? t('siteManagerDialog.titleNewLocalPath')
                : t('siteManagerDialog.titleEditLocalPath')
              : editingId === '__new__'
                ? t('siteManagerDialog.titleNew')
                : t('siteManagerDialog.titleEdit')
            : t(
                isLocalPathManager
                  ? 'siteManagerDialog.titleLocalPathList'
                  : 'siteManagerDialog.titleList',
              )
        }
        onClose={editing ? cancelEdit : onClose}
        className="modal-site-manager"
        closeDisabled={!!pendingDelete || saving}
        footer={
          editing ? (
            <ModalFooterActions
              onCancel={cancelEdit}
              onConfirm={handler(handleSubmit)}
              confirmLabel={t('common.save')}
              cancelDisabled={saving}
              confirmDisabled={!canSubmit || saving}
            />
          ) : (
            footerMessage && (
              <div
                ref={footerRef}
                className={`site-manager-footer${footerTruncated ? ' truncated' : ''}`}
              >
                {footerMessage}
              </div>
            )
          )
        }
      >
        {!editing && (
          <div className={`site-manage-toolbar${searchOpen ? ' search-open' : ''}`}>
            <button
              type="button"
              className={`btn btn-ghost btn-icon${searchOpen ? ' active' : ''}`}
              data-tooltip={t('siteManagerDialog.searchPlaceholder')}
              aria-label={t('siteManagerDialog.searchPlaceholder')}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              <Icon name="search" size={13} />
            </button>
            <div className="site-manage-search">
              <input
                ref={searchInputRef}
                type="text"
                tabIndex={searchOpen ? undefined : -1}
                placeholder={t('siteManagerDialog.searchPlaceholder')}
                aria-label={t('siteManagerDialog.searchPlaceholder')}
                value={searchQuery}
                onFocus={() => setSearchOpen(true)}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  setSearchQuery('');
                  closeSearch();
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="filter-clear"
                  aria-label={t('siteManagerDialog.clearSearch')}
                  onClick={() => setSearchQuery('')}
                >
                  ✕
                </button>
              )}
            </div>
            <SortModeSelect
              value={sortMode}
              onChange={setSortMode}
              t={t}
              allowProtocol={!isLocalPathManager}
            />
            <div className="site-manage-actions">
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                data-tooltip={t('siteManagerDialog.newFolder')}
                aria-label={t('siteManagerDialog.newFolder')}
                disabled={saving}
                onClick={startAddFolder}
              >
                <Icon name="folderPlus" size={14} />
              </button>
              {isLocalPathManager ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('siteManagerDialog.addLocalBookmark')}
                  aria-label={t('siteManagerDialog.addLocalBookmark')}
                  disabled={saving}
                  onClick={() => startAddLocal()}
                >
                  <Icon name="starPlus" size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('siteManagerDialog.addBookmark')}
                  aria-label={t('siteManagerDialog.addBookmark')}
                  disabled={saving}
                  onClick={() => startAdd()}
                >
                  <Icon name="starPlus" size={14} />
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={t('siteManagerDialog.importBookmarks')}
                data-tooltip={t('siteManagerDialog.importBookmarks')}
                onClick={() => setShowImportOptions(true)}
              >
                <Icon name="fileDown" size={14} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={t('siteManagerDialog.exportBookmarks')}
                data-tooltip={t('siteManagerDialog.exportBookmarks')}
                onClick={() => setShowExportOptions(true)}
              >
                <Icon name="fileUp" size={14} />
              </button>
            </div>
          </div>
        )}
        {editing ? (
          <SiteEditor
            form={form}
            setForm={setForm}
            error={error}
            onDismissError={() => setError('')}
            onField={handleField}
            onProtocolChange={handleProtocolChange}
            onChooseKeyFile={chooseKeyFile}
            onChooseCaCertFile={chooseCaCertFile}
            onChooseLocalPath={chooseLocalPath}
            onRevealSecret={revealSavedSecret}
            rsaKeySelected={rsaKeySelected}
            passwordRef={passwordRef}
            keyPassphraseRef={keyPassphraseRef}
            t={t}
          />
        ) : (
          <>
            {error && (
              <DismissibleError
                className="form-error site-manager-error"
                message={error}
                closeLabel={t('common.close')}
                onDismiss={() => setError('')}
              />
            )}
            {isSearching ? (
              <SiteSearchResults
                sites={filteredSites}
                entriesById={entriesById}
                onConnect={onConnect}
                onEdit={startEdit}
                onDuplicate={duplicateSite}
                onRequestDelete={setPendingDelete}
                renamingSiteId={renamingSiteId}
                renameSiteName={renameSiteName}
                onRenameSiteNameChange={setRenameSiteName}
                onCommitRenameSite={handler(commitRenameSite)}
                onCancelRenameSite={() => setRenamingSiteId(null)}
                onStartRenameSite={startRenameSite}
                t={t}
              />
            ) : (
              <SiteTree
                sensors={sensors}
                collisionDetection={collisionDetection}
                modifiers={modifiers}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
                activeId={activeId}
                activeEntry={activeEntry}
                activeRect={activeRect}
                canCollapseSource={canCollapseSource}
                localEntries={localEntries}
                addingFolder={addingFolder}
                newFolderName={newFolderName}
                onNewFolderNameChange={setNewFolderName}
                onCommitAddFolder={handler(commitAddFolder)}
                onCancelAddFolder={() => setAddingFolder(false)}
                containers={containers}
                dragContentHeight={dragContentHeight}
                entriesById={entriesById}
                expandedFolderIds={expandedFolderIds}
                renamingFolderId={renamingFolderId}
                renameFolderName={renameFolderName}
                renamingSiteId={renamingSiteId}
                renameSiteName={renameSiteName}
                dropTargetFolderId={dropTargetFolderId}
                onRenameFolderNameChange={setRenameFolderName}
                onCommitRenameFolder={handler(commitRenameFolder)}
                onCancelRenameFolder={() => setRenamingFolderId(null)}
                onRenameSiteNameChange={setRenameSiteName}
                onCommitRenameSite={handler(commitRenameSite)}
                onCancelRenameSite={() => setRenamingSiteId(null)}
                onStartRenameSite={startRenameSite}
                onToggleFolder={toggleFolder}
                onStartRenameFolder={startRenameFolder}
                onRequestDelete={setPendingDelete}
                onConnect={onConnect}
                onEdit={startEdit}
                onDuplicate={duplicateSite}
                onCreateInFolder={isLocalPathManager ? startAddLocal : startAdd}
                onMoveEntry={sortMode === 'manual' ? moveEntryBy : undefined}
                reorderEnabled={sortMode === 'manual'}
                registerRowNode={registerRowNode}
                t={t}
              />
            )}
          </>
        )}
      </Modal>

      {pendingDelete && (
        <ConfirmDialog
          message={t(
            pendingDelete.kind === 'folder'
              ? 'siteManagerDialog.confirmDeleteFolder'
              : 'siteManager.confirmDeleteSite',
            { name: isolate(pendingDelete.name) },
          )}
          onConfirm={handleDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
      {pendingDuplicate && (
        <ConfirmDialog
          message={t('siteManagerDialog.duplicateWarning', {
            name: isolate(pendingDuplicate.name),
          })}
          confirmLabel={t('siteManagerDialog.saveAnyway')}
          onConfirm={() => {
            setPendingDuplicate(null);
            void handleSubmit(true);
          }}
          onClose={() => setPendingDuplicate(null)}
        />
      )}
      {showExportOptions && (
        <ExportSettingsDialog
          onExport={handleExportConfirm}
          onClose={() => setShowExportOptions(false)}
          initialOptions={{
            includeSettings: false,
            includeBookmarks: !isLocalPathManager,
            includeLocalPaths: isLocalPathManager,
          }}
        />
      )}
      {showImportOptions && (
        <ImportSettingsDialog
          onImport={handleImportConfirm}
          onClose={() => setShowImportOptions(false)}
          initialOptions={{
            includeSettings: false,
            includeBookmarks: !isLocalPathManager,
            includeLocalPaths: isLocalPathManager,
          }}
        />
      )}
    </>
  );
}
