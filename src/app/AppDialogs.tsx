import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import ConfirmDialog from '../components/ConfirmDialog.tsx';
import ContextMenu from '../components/ContextMenu.tsx';
import MoveToFolderDialog from '../components/MoveToFolderDialog.tsx';
import PromptDialog from '../components/PromptDialog.tsx';
import VaultUnlockDialog from '../components/VaultUnlockDialog.tsx';
import { parentRemotePath } from '../features/file-browser/index.ts';
import type { PaneId, SiteProtocol } from '../shared/types.ts';
import type { PaneState, TabState, usePanes } from '../features/file-browser/index.ts';
import type { useAppDialogs } from './useAppDialogs.ts';
import type { useOpenWithLifecycle } from '../features/open-with/index.ts';
import { reportRejection } from '../shared/asyncFailure.ts';
import { api } from '../platform/api/index.ts';

const AboutDialog = lazy(() => import('../components/AboutDialog.tsx'));
const ExportSettingsDialog = lazy(() => import('../components/ExportSettingsDialog.tsx'));
const ImportSettingsDialog = lazy(() => import('../components/ImportSettingsDialog.tsx'));
const OpenWithDialog = lazy(() =>
  import('../features/open-with/ui.ts').then(({ OpenWithDialog }) => ({
    default: OpenWithDialog,
  })),
);
const SettingsDialog = lazy(() =>
  import('../features/settings/ui.ts').then(({ SettingsDialog }) => ({
    default: SettingsDialog,
  })),
);
const SiteManagerDialog = lazy(() =>
  import('../features/sites/ui.ts').then(({ SiteManagerDialog }) => ({
    default: SiteManagerDialog,
  })),
);

type SettingsDialogProps = ComponentProps<typeof SettingsDialog>;
type SettingsValues = Omit<
  SettingsDialogProps,
  | 'updateStatus'
  | 'checkForUpdates'
  | 'onExportDiagnostics'
  | 'narrow'
  | 'onPreview'
  | 'onSave'
  | 'onClose'
>;
type SiteManagerProps = ComponentProps<typeof SiteManagerDialog>;
type DialogHook = ReturnType<typeof useAppDialogs>;
type DialogControls = Pick<
  DialogHook,
  | 'showSettings'
  | 'setShowSettings'
  | 'showAbout'
  | 'setShowAbout'
  | 'showSaveSite'
  | 'setShowSaveSite'
  | 'showSiteManagerDialog'
  | 'setShowSiteManagerDialog'
  | 'showLocalPathManagerDialog'
  | 'setShowLocalPathManagerDialog'
  | 'showExportSettings'
  | 'setShowExportSettings'
  | 'showImportSettings'
  | 'setShowImportSettings'
  | 'newFolderTarget'
  | 'setNewFolderTarget'
  | 'newFileTarget'
  | 'setNewFileTarget'
  | 'moveToTarget'
  | 'setMoveToTarget'
  | 'chmodTarget'
  | 'setChmodTarget'
  | 'driveMenu'
  | 'setDriveMenu'
  | 'confirmState'
  | 'setConfirmState'
  | 'vaultUnlockRetries'
  | 'setVaultUnlockRetries'
>;
type OpenWithLifecycle = ReturnType<typeof useOpenWithLifecycle>;

export interface AppDialogsModel {
  settings: {
    values: SettingsValues;
    preview: SettingsDialogProps['onPreview'];
    save: SettingsDialogProps['onSave'];
    export: (options: Record<string, unknown>) => Promise<boolean>;
    import: SiteManagerProps['onImport'];
    exportDiagnostics: SettingsDialogProps['onExportDiagnostics'];
  };
  dialogs: DialogControls;
  updater: {
    status: SettingsDialogProps['updateStatus'];
    check: SettingsDialogProps['checkForUpdates'];
  };
  siteActions: {
    sites: SiteManagerProps['entries'];
    save: SiteManagerProps['onSave'];
    delete: SiteManagerProps['onDelete'];
    applyLayout: SiteManagerProps['onApplyLayout'];
    saveFolder: SiteManagerProps['onSaveFolder'];
    deleteFolder: SiteManagerProps['onDeleteFolder'];
    connect: (site: SiteManagerProps['entries'][number], paneId?: PaneId) => unknown;
  };
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  tabs: readonly TabState[];
  paneActions: {
    submitNewFolder: (name: string, tabId: string, paneId: PaneId) => unknown;
    submitNewFile: (name: string, tabId: string, paneId: PaneId) => unknown;
    confirmOverwriteIfNeeded: (
      pane: PaneState,
      folderName: string,
      names: string[],
      proceed: (names: string[]) => unknown,
      entries: PaneState['entries'],
    ) => unknown;
    movePaneSamePane: (
      paneId: PaneId,
      names: string[],
      folderName: string,
      tabId: string,
    ) => unknown;
    chmod: (target: NonNullable<DialogHook['chmodTarget']>, mode: string) => unknown;
  };
  openWith: OpenWithLifecycle & {
    applicationFor: (path: string) => string | null;
  };
  runUpload: (
    connectionId: string,
    protocol: SiteProtocol,
    localPath: string,
    name: string,
    remotePath: string,
  ) => Promise<unknown>;
  refreshPane: ReturnType<typeof usePanes>['refreshPane'];
  windowNarrow: boolean;
}

interface AppDialogsProps {
  model: AppDialogsModel;
}

export default function AppDialogs({ model }: AppDialogsProps) {
  const { t } = useTranslation();
  const {
    settings,
    dialogs,
    updater,
    siteActions,
    panes,
    activeTabId,
    tabs,
    paneActions,
    openWith,
    runUpload,
    refreshPane,
  } = model;
  const changedWatch = openWith.changedId ? openWith.watches[openWith.changedId] : undefined;

  return (
    <Suspense fallback={null}>
      {dialogs.showSettings && (
        <SettingsDialog
          {...settings.values}
          updateStatus={updater.status}
          checkForUpdates={updater.check}
          onExportDiagnostics={settings.exportDiagnostics}
          narrow={model.windowNarrow}
          onPreview={settings.preview}
          onSave={settings.save}
          onClose={() => dialogs.setShowSettings(false)}
        />
      )}
      {dialogs.showAbout && (
        <AboutDialog appApi={api.app} onClose={() => dialogs.setShowAbout(false)} />
      )}
      {dialogs.showSiteManagerDialog && (
        <SiteManagerDialog
          managerKind="bookmarks"
          entries={siteActions.sites}
          onSave={siteActions.save}
          onDelete={siteActions.delete}
          onApplyLayout={siteActions.applyLayout}
          onSaveFolder={siteActions.saveFolder}
          onDeleteFolder={siteActions.deleteFolder}
          onImport={settings.import}
          onExport={settings.export}
          onConnect={(site) => {
            const targetPaneId =
              dialogs.showSiteManagerDialog === true ? undefined : dialogs.showSiteManagerDialog;
            dialogs.setShowSiteManagerDialog(false);
            siteActions.connect(site, targetPaneId || undefined);
          }}
          onVaultUnlockRequired={(retry) =>
            dialogs.setVaultUnlockRetries((current) => [...current, retry])
          }
          onClose={() => dialogs.setShowSiteManagerDialog(false)}
        />
      )}
      {dialogs.showLocalPathManagerDialog && (
        <SiteManagerDialog
          managerKind="localPaths"
          entries={siteActions.sites}
          onSave={siteActions.save}
          onDelete={siteActions.delete}
          onApplyLayout={siteActions.applyLayout}
          onSaveFolder={siteActions.saveFolder}
          onDeleteFolder={siteActions.deleteFolder}
          onImport={settings.import}
          onExport={settings.export}
          onConnect={(path) => {
            const targetPaneId =
              dialogs.showLocalPathManagerDialog === true
                ? undefined
                : dialogs.showLocalPathManagerDialog;
            dialogs.setShowLocalPathManagerDialog(false);
            siteActions.connect(path, targetPaneId || undefined);
          }}
          onVaultUnlockRequired={(retry) =>
            dialogs.setVaultUnlockRetries((current) => [...current, retry])
          }
          onClose={() => dialogs.setShowLocalPathManagerDialog(false)}
        />
      )}
      {dialogs.vaultUnlockRetries.length > 0 && (
        <VaultUnlockDialog
          vaultApi={api.vault}
          onUnlocked={() => {
            const retries = dialogs.vaultUnlockRetries;
            dialogs.setVaultUnlockRetries([]);
            retries.forEach((retry) => retry());
          }}
          onClose={() => dialogs.setVaultUnlockRetries([])}
        />
      )}
      {dialogs.showExportSettings && (
        <ExportSettingsDialog
          onExport={settings.export}
          onClose={() => dialogs.setShowExportSettings(false)}
          initialOptions={{
            includeSettings: true,
            includeBookmarks: false,
            includeLocalPaths: false,
          }}
        />
      )}
      {dialogs.showImportSettings && (
        <ImportSettingsDialog
          onImport={settings.import}
          onClose={() => dialogs.setShowImportSettings(false)}
          initialOptions={{
            includeSettings: true,
            includeBookmarks: false,
            includeLocalPaths: false,
          }}
        />
      )}
      {openWith.target && (
        <OpenWithDialog
          remotePath={openWith.target.path}
          connectionId={openWith.target.connectionId}
          size={openWith.target.size}
          application={openWith.applicationFor(openWith.target.path)}
          onOpened={openWith.registerOpened}
          onClose={() => openWith.setTarget(null)}
        />
      )}
      {changedWatch && (
        <ConfirmDialog
          title={t('openWithChanged.title')}
          message={t('openWithChanged.message', { name: changedWatch.name })}
          confirmLabel={t('common.upload')}
          danger={false}
          onConfirm={() => {
            const watch = changedWatch;
            const targetPane = tabs.find((tab) => tab.id === watch.tabId)?.panes[watch.paneId];
            if (!targetPane?.protocol) return;
            const upload = runUpload(
              watch.connectionId,
              targetPane.protocol,
              watch.localPath,
              watch.name,
              parentRemotePath(watch.remotePath),
            );
            reportRejection(
              upload.then(() =>
                refreshPane(watch.paneId, targetPane.path, targetPane, watch.tabId),
              ),
            );
          }}
          onClose={() => openWith.setChangedId(null)}
        />
      )}
      {dialogs.showSaveSite && (
        <SiteManagerDialog
          managerKind={dialogs.showSaveSite.kind === 'local' ? 'localPaths' : 'bookmarks'}
          initialForm={dialogs.showSaveSite}
          entries={siteActions.sites}
          onSave={async (payload) => {
            const result = await siteActions.save(payload);
            if (result?.ok) dialogs.setShowSaveSite(false);
            return result;
          }}
          onDelete={siteActions.delete}
          onApplyLayout={siteActions.applyLayout}
          onSaveFolder={siteActions.saveFolder}
          onDeleteFolder={siteActions.deleteFolder}
          onImport={settings.import}
          onExport={settings.export}
          onConnect={siteActions.connect}
          onVaultUnlockRequired={(retry) =>
            dialogs.setVaultUnlockRetries((current) => [...current, retry])
          }
          onClose={() => dialogs.setShowSaveSite(false)}
        />
      )}
      {dialogs.newFolderTarget && (
        <PromptDialog
          title={t('newFolder.title')}
          label={
            panes[dialogs.newFolderTarget].kind === 'local'
              ? t('newFolder.labelLocal')
              : t('newFolder.labelRemote')
          }
          confirmLabel={t('common.create')}
          onSubmit={(name) => {
            if (dialogs.newFolderTarget) {
              paneActions.submitNewFolder(name, activeTabId, dialogs.newFolderTarget);
            }
          }}
          onClose={() => dialogs.setNewFolderTarget(null)}
        />
      )}
      {dialogs.newFileTarget && (
        <PromptDialog
          title={t('newFile.title')}
          label={t('newFile.label')}
          confirmLabel={t('common.create')}
          onSubmit={(name) => {
            if (dialogs.newFileTarget) {
              paneActions.submitNewFile(name, activeTabId, dialogs.newFileTarget);
            }
          }}
          onClose={() => dialogs.setNewFileTarget(null)}
        />
      )}
      {dialogs.moveToTarget && (
        <MoveToFolderDialog
          title={t('moveToDialog.title')}
          label={
            dialogs.moveToTarget.names.length === 1
              ? t('moveToDialog.labelSingle', { name: dialogs.moveToTarget.names[0] })
              : t('moveToDialog.labelMultiple', { count: dialogs.moveToTarget.names.length })
          }
          folders={dialogs.moveToTarget.folders}
          onSubmit={(folderName) => {
            const target = dialogs.moveToTarget;
            if (!target) return;
            const pane = panes[target.id];
            paneActions.confirmOverwriteIfNeeded(
              pane,
              folderName,
              target.names,
              (names) => paneActions.movePaneSamePane(target.id, names, folderName, activeTabId),
              pane.entries,
            );
          }}
          onClose={() => dialogs.setMoveToTarget(null)}
        />
      )}
      {dialogs.chmodTarget && (
        <PromptDialog
          title={t('chmodDialog.title')}
          label={t('chmodDialog.label', { name: dialogs.chmodTarget.entry.name })}
          defaultValue={dialogs.chmodTarget.mode}
          confirmLabel={t('common.save')}
          onSubmit={(mode) => {
            const target = dialogs.chmodTarget;
            if (target) paneActions.chmod(target, mode);
          }}
          onClose={() => dialogs.setChmodTarget(null)}
        />
      )}
      {dialogs.confirmState && (
        <ConfirmDialog
          message={dialogs.confirmState.message}
          onConfirm={dialogs.confirmState.onConfirm}
          confirmLabel={dialogs.confirmState.confirmLabel}
          danger={dialogs.confirmState.danger}
          onCancel={dialogs.confirmState.onCancel}
          onClose={() => dialogs.setConfirmState(null)}
        />
      )}
      {dialogs.driveMenu && (
        <ContextMenu
          x={dialogs.driveMenu.x}
          y={dialogs.driveMenu.y}
          items={dialogs.driveMenu.items}
          className="drive-select-menu"
          width={84}
          onClose={() => dialogs.setDriveMenu(null)}
        />
      )}
    </Suspense>
  );
}
