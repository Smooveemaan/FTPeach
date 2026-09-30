import type { MouseEvent as ReactMouseEvent } from 'react';
import type { MenuItem as ShellMenuItem } from '../../components/MenuItems.tsx';
import { api } from '../../platform/api/index.ts';
import { reportAsyncFailure, reportRejection } from '../../shared/asyncFailure.ts';
import type { FriendlyErrorInput } from '../../shared/errorMessages.ts';
import { commandResultError } from '../../shared/errorMessages.ts';
import type { FileEntry } from '../../shared/paneContracts.ts';
import type { ManagedSite } from '../../shared/siteContracts.ts';
import type { Translate } from '../../shared/translate.ts';
import { formatBinding } from '../../shortcuts/bindings.ts';
import type { ShortcutOverrides } from '../../shortcuts/resolve.ts';
import { effectiveBinding } from '../../shortcuts/resolve.ts';
import type { OpenWithTarget } from '../open-with/index.ts';
import type { TransfersModel } from '../transfers/index.ts';
import type { DroppedFile } from './components/useFileDragDrop.ts';
import type { PaneId, PaneState } from './panes/paneModel.ts';
import { otherPaneId } from './panes/paneModel.ts';
import type { PanesModel } from './usePanes.ts';

interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onClick?: () => unknown;
}
interface PaneMenuOptions {
  permanent?: boolean;
  folderOrder?: string[];
}

/**
 * What only the application can do for a pane. `app/` passes the objects that
 * own these (its dialog state, transfers, the "Open with" lifecycle), so a
 * call names the owner rather than an alias for it.
 */
export interface FileBrowserShell {
  dialogs: {
    setNewFolderTarget: (id: PaneId) => unknown;
    setNewFileTarget: (id: PaneId) => unknown;
    setMoveToTarget: (target: { id: PaneId; names: string[]; folders: string[] }) => unknown;
    setChmodTarget: (target: { id: PaneId; entry: FileEntry; mode: string }) => unknown;
    setShowSiteManagerDialog: (id: PaneId) => unknown;
    setShowLocalPathManagerDialog: (id: PaneId) => unknown;
    driveMenu: { id: PaneId } | null;
    setDriveMenu: (
      menu: { id: PaneId; x: number; y: number; items: ShellMenuItem[] } | null,
    ) => unknown;
  };
  transfers: Pick<TransfersModel, 'copyEntries' | 'handleOsDropFiles'>;
  openWith: { setTarget: (target: OpenWithTarget) => unknown };
  /** Opens the dialog that saves the pane as a bookmark or a local path. */
  saveSite: (id: PaneId) => () => unknown;
  reportError: (error: FriendlyErrorInput) => unknown;
}

interface PaneActionsOptions {
  t: Translate;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
  browser: Pick<
    PanesModel,
    | 'panes'
    | 'activeTabId'
    | 'paneJoin'
    | 'navigatePane'
    | 'refreshPane'
    | 'canCopyBetween'
    | 'confirmOverwriteIfNeeded'
    | 'deletePaneSelected'
    | 'deletePaneEntry'
    | 'connectPane'
    | 'siteConnectPane'
    | 'goPaneHome'
  >;
  /** The bookmarks a pane reconnects through and goes home to. */
  sites: readonly ManagedSite[];
  shell: Pick<FileBrowserShell, 'dialogs' | 'transfers' | 'openWith' | 'reportError'>;
  /** Asks for the program "Open with…" uses; null when the user cancels. */
  selectApplication?: () => Promise<string | null>;
  clipboard?: Pick<Clipboard, 'writeText'> | null;
}

export function moveToFolders(names: readonly string[], folderOrder: readonly string[]): string[] {
  return folderOrder.filter((name) => !names.includes(name));
}

export function permissionStringToOctal(value?: string | null, fallback = '644'): string {
  if (!/^[rwx-]{9}$/.test(value || '')) return fallback;
  const permissions = value!;
  return [0, 3, 6]
    .map((offset) =>
      String(
        (permissions[offset] === 'r' ? 4 : 0) +
          (permissions[offset + 1] === 'w' ? 2 : 0) +
          (permissions[offset + 2] === 'x' ? 1 : 0),
      ),
    )
    .join('');
}

export interface PaneActionsModel {
  buildPaneMenu: (
    id: PaneId,
  ) => (entry: FileEntry | null, { permanent, folderOrder }?: PaneMenuOptions) => MenuItem[];
  /** Reconnects a pane, through its bookmark while the bookmark still exists. */
  connect: (id: PaneId) => () => unknown;
  /** Opens a local file with its program; the backend asks before running one. */
  openLocalFile: (path: string) => Promise<void>;
  dropFiles: (id: PaneId, files: DroppedFile[], targetFolder: string | null) => Promise<void>;
  moveTo: (id: PaneId, folderOrder: string[]) => void;
  goHome: (id: PaneId) => void;
  openDriveMenu: (id: PaneId) => (event: ReactMouseEvent<HTMLElement>) => Promise<void>;
}

export function usePaneActions({
  t,
  keyboardShortcuts,
  browser,
  sites,
  shell,
  selectApplication = () => api.fsLocal.selectApplication(),
  clipboard = navigator.clipboard,
}: PaneActionsOptions): PaneActionsModel {
  const {
    panes,
    activeTabId,
    paneJoin,
    navigatePane,
    refreshPane,
    canCopyBetween,
    confirmOverwriteIfNeeded,
    deletePaneSelected,
    deletePaneEntry,
  } = browser;
  const { setNewFolderTarget, setNewFileTarget, setMoveToTarget, setChmodTarget } = shell.dialogs;
  const { copyEntries } = shell.transfers;
  const copyPath = (text: string) => clipboard?.writeText(text).catch(reportAsyncFailure);
  const shortcutLabel = (actionId: string) =>
    formatBinding(effectiveBinding(actionId, keyboardShortcuts));

  const buildPaneMenu =
    (id: PaneId) =>
    (
      entry: FileEntry | null,
      { permanent = false, folderOrder = [] }: PaneMenuOptions = {},
    ): MenuItem[] => {
      const pane = panes[id];
      const disabledForRemote = pane.kind === 'remote' && pane.status !== 'connected';
      if (!entry) {
        return [
          {
            label: t('paneMenu.newFolder'),
            disabled: disabledForRemote,
            onClick: () => setNewFolderTarget(id),
          },
          {
            label: t('paneMenu.newFile'),
            disabled: disabledForRemote,
            onClick: () => setNewFileTarget(id),
          },
          {
            label: t('paneMenu.refresh'),
            disabled: disabledForRemote,
            onClick: () => refreshPane(id, pane.path),
          },
        ];
      }

      const items: MenuItem[] = [];
      const actsOnSelection = pane.selected.size > 1 && pane.selected.has(entry.name);
      if (entry.isDirectory) {
        items.push({
          label: t('paneMenu.open'),
          onClick: () => navigatePane(id, paneJoin(pane, entry.name)),
        });
      } else {
        const otherId = otherPaneId(id);
        const otherPane = panes[otherId];
        items.push({
          label:
            pane.kind === 'local'
              ? t('paneMenu.uploadToOtherPane')
              : otherPane.kind === 'remote'
                ? t('paneMenu.copyToOtherPane')
                : t('paneMenu.downloadToOtherPane'),
          disabled: !canCopyBetween(pane, otherPane),
          onClick: () =>
            confirmOverwriteIfNeeded(
              otherPane,
              undefined,
              [entry.name],
              (names, overwriteApproved) =>
                copyEntries({
                  sourcePane: pane,
                  targetPane: otherPane,
                  names,
                  move: false,
                  refreshTarget: () => refreshPane(otherId, otherPane.path),
                  overwriteApproved,
                }),
              [entry],
            ),
        });
        if (pane.kind === 'remote') {
          // Same as a double click: the associated or the system's program.
          items.push({
            label: t('paneMenu.open'),
            disabled: !pane.connectionId,
            onClick: () => {
              const connectionId = pane.connectionId;
              if (!connectionId) return;
              shell.openWith.setTarget({
                path: paneJoin(pane, entry.name),
                size: entry.size,
                connectionId,
                paneId: id,
                tabId: activeTabId,
              });
            },
          });
          items.push({
            label: t('paneMenu.openWith'),
            disabled: !pane.connectionId,
            onClick: () => {
              const connectionId = pane.connectionId;
              if (!connectionId) return;
              reportRejection(
                selectApplication().then((application) => {
                  if (!application) return;
                  shell.openWith.setTarget({
                    path: paneJoin(pane, entry.name),
                    application,
                    size: entry.size,
                    connectionId,
                    paneId: id,
                    tabId: activeTabId,
                  });
                }),
              );
            },
          });
        }
      }

      items.push({ separator: true });
      if (pane.kind === 'remote' && pane.form.protocol === 'sftp') {
        items.push({
          label: t('paneMenu.permissions'),
          onClick: () =>
            setChmodTarget({ id, entry, mode: permissionStringToOctal(entry.permissions) }),
        });
        items.push({ separator: true });
      }
      const names = actsOnSelection ? [...pane.selected] : [entry.name];
      const folders = moveToFolders(names, folderOrder);
      items.push({
        label: t('paneMenu.moveTo'),
        shortcut: shortcutLabel('move-to'),
        disabled: disabledForRemote || folders.length === 0,
        onClick: () => setMoveToTarget({ id, names, folders }),
      });
      items.push({ separator: true });
      items.push({
        label: t('paneMenu.copyPath'),
        onClick: () => copyPath(paneJoin(pane, entry.name)),
      });
      items.push({ separator: true });
      items.push({
        label:
          pane.kind === 'local' && permanent
            ? actsOnSelection
              ? t('paneMenu.deleteSelectedPermanently', { count: pane.selected.size })
              : t('paneMenu.deletePermanently')
            : actsOnSelection
              ? t('paneMenu.deleteSelected', { count: pane.selected.size })
              : t('paneMenu.delete'),
        danger: true,
        onClick: () =>
          actsOnSelection
            ? deletePaneSelected(id, activeTabId, permanent)
            : deletePaneEntry(id, entry, activeTabId, permanent),
      });
      items.push({ separator: true });
      items.push({
        label: t('paneMenu.refresh'),
        onClick: () => refreshPane(id, pane.path),
      });
      return items;
    };

  const bookmarkOf = (pane: PaneState) =>
    pane.siteId ? sites.find((candidate) => candidate.id === pane.siteId) : undefined;

  // A pane can still carry `siteId` after a disconnect, or after restoring a
  // saved tab layout, while its `form` is a snapshot from whenever it was
  // last built. Reconnecting through the plain form would silently drop the
  // bookmark's current remotePath (and any other edits) back to '/' — route
  // through siteConnectPane so a still-known bookmark stays authoritative.
  const connect = (id: PaneId) => {
    const site = bookmarkOf(panes[id]);
    return site ? () => browser.siteConnectPane(id, site) : browser.connectPane(id);
  };

  const openLocalFile = (path: string) =>
    api.fsLocal.openPath(path).then((result) => {
      // Declining the backend's confirmation is not a failure to report: the
      // user cancelled it themselves and nothing was run.
      if (!result.ok && result.errorCode !== 'cancelled')
        shell.reportError(commandResultError(result));
    });

  const dropFiles = (id: PaneId, files: DroppedFile[], targetFolder: string | null) => {
    const pane = panes[id];
    return confirmOverwriteIfNeeded(
      pane,
      targetFolder ?? undefined,
      files.map((file) => file.name),
      (names, overwriteApproved) =>
        shell.transfers.handleOsDropFiles(
          pane,
          files.filter((file) => names.includes(file.name)),
          targetFolder,
          () => refreshPane(id, pane.path),
          overwriteApproved,
        ),
      files,
    );
  };

  const moveTo = (id: PaneId, folderOrder: string[]) => {
    const names = [...panes[id].selected];
    const folders = moveToFolders(names, folderOrder);
    if (folders.length > 0) setMoveToTarget({ id, names, folders });
  };

  const goHome = (id: PaneId) => {
    const pane = panes[id];
    if (pane.kind === 'local') {
      // Callers discard what this returns, so a failure to read the home
      // directory is reported here.
      reportRejection(browser.goPaneHome(id)());
      return;
    }
    if (pane.status !== 'connected') return;
    reportRejection(navigatePane(id, bookmarkOf(pane)?.remotePath || '/'));
  };

  const openDriveMenu = (id: PaneId) => async (event: ReactMouseEvent<HTMLElement>) => {
    const { driveMenu, setDriveMenu } = shell.dialogs;
    if (driveMenu?.id === id) {
      setDriveMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const drives = await api.fsLocal.drives();
    const currentPath = (panes[id].path || '').toUpperCase();
    setDriveMenu({
      id,
      x: document.documentElement.dir === 'rtl' ? rect.right : rect.left,
      y: rect.bottom,
      items: drives.map((drive) => ({
        label: drive.label,
        checked: currentPath.startsWith(drive.path.toUpperCase()),
        onClick: () => navigatePane(id, drive.path),
      })),
    });
  };

  return { buildPaneMenu, connect, openLocalFile, dropFiles, moveTo, goHome, openDriveMenu };
}
