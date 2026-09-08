import { reportAsyncFailure } from '../../shared/asyncFailure.ts';
import type { FileEntry, Translate } from '../../shared/types.ts';
import { formatBinding } from '../../shortcuts/bindings.ts';
import type { ShortcutOverrides } from '../../shortcuts/resolve.ts';
import { effectiveBinding } from '../../shortcuts/resolve.ts';
import type { OpenWithTarget } from '../open-with/index.ts';
import type { PaneId, PaneState } from './panes/paneModel.ts';
import { otherPaneId } from './panes/paneModel.ts';

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
interface CopyEntriesOptions {
  sourcePane: PaneState;
  targetPane: PaneState;
  names: string[];
  targetFolder?: string;
  move: boolean;
  refreshTarget: () => unknown;
}
interface PaneActionsOptions {
  t: Translate;
  keyboardShortcuts?: ShortcutOverrides | null;
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  paneJoin: (pane: PaneState, name: string) => string;
  navigatePane: (id: PaneId, path: string) => unknown;
  refreshPane: (id: PaneId, path: string) => unknown;
  canCopyBetween: (source: PaneState, target: PaneState) => boolean;
  confirmOverwriteIfNeeded: (
    target: PaneState,
    targetFolder: string | undefined,
    names: string[],
    proceed: (names: string[]) => unknown,
    entries: FileEntry[],
  ) => unknown;
  copyEntries: (options: CopyEntriesOptions) => unknown;
  deletePaneSelected: (id: PaneId, tabId: string, permanent: boolean) => unknown;
  deletePaneEntry: (id: PaneId, entry: FileEntry, tabId: string, permanent: boolean) => unknown;
  setNewFolderTarget: (id: PaneId) => unknown;
  setNewFileTarget: (id: PaneId) => unknown;
  setMoveToTarget: (value: { id: PaneId; names: string[]; folders: string[] }) => unknown;
  setChmodTarget: (value: { id: PaneId; entry: FileEntry; mode: string }) => unknown;
  setOpenWithTarget: (value: OpenWithTarget) => unknown;
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
  moveToFolders: (names: readonly string[], folderOrder: readonly string[]) => string[];
}

export function usePaneActions({
  t,
  keyboardShortcuts,
  panes,
  activeTabId,
  paneJoin,
  navigatePane,
  refreshPane,
  canCopyBetween,
  confirmOverwriteIfNeeded,
  copyEntries,
  deletePaneSelected,
  deletePaneEntry,
  setNewFolderTarget,
  setNewFileTarget,
  setMoveToTarget,
  setChmodTarget,
  setOpenWithTarget,
  clipboard = navigator.clipboard,
}: PaneActionsOptions): PaneActionsModel {
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
            shortcut: shortcutLabel('refresh'),
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
              (names) =>
                copyEntries({
                  sourcePane: pane,
                  targetPane: otherPane,
                  names,
                  move: false,
                  refreshTarget: () => refreshPane(otherId, otherPane.path),
                }),
              [entry],
            ),
        });
        if (pane.kind === 'remote') {
          items.push({
            label: t('paneMenu.openWith'),
            disabled: !pane.connectionId,
            onClick: () => {
              if (!pane.connectionId) return;
              setOpenWithTarget({
                path: paneJoin(pane, entry.name),
                size: entry.size,
                connectionId: pane.connectionId,
                paneId: id,
                tabId: activeTabId,
              });
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
        shortcut: shortcutLabel('refresh'),
        onClick: () => refreshPane(id, pane.path),
      });
      return items;
    };

  return { buildPaneMenu, moveToFolders };
}
