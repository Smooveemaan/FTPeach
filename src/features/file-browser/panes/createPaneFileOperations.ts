import { joinLocalPath, joinRemotePath } from '../../../shared/paths.ts';
import { mapWithConcurrency } from '../../../shared/lang.ts';
import { isolate } from '../../../shared/bidi.ts';
import { commandResultError } from '../../../shared/errorMessages.ts';
import type { FriendlyErrorInput } from '../../../shared/errorMessages.ts';
import type { Translate } from '../components/fileListModel.ts';
import { backendFor, paneJoin } from './paneBackend.ts';
import type { FileEntry } from '../../../shared/types.ts';
import type { PaneId, PaneState } from './paneModel.ts';
import { api } from '../../../platform/api/index.ts';

const DELETE_CONCURRENCY_LIMIT = 8;

interface PaneFileOperationsOptions {
  client?: Pick<Window['api'], 'fsLocal' | 'session'>;
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  requestConfirm: (message: string, onConfirm: () => unknown) => unknown;
  reportError: (error: FriendlyErrorInput) => unknown;
  refreshPane: (id: PaneId, path: string, paneOverride?: PaneState, tabId?: string) => unknown;
  navigatePane: (id: PaneId, path: string) => unknown;
  t: Translate;
}

export function createPaneFileOperations({
  client = api,
  panes,
  activeTabId,
  requestConfirm,
  reportError,
  refreshPane,
  navigatePane,
  t,
}: PaneFileOperationsOptions) {
  // Toolbar actions

  const deletePaneSelected = (id: PaneId, tabId = activeTabId, permanent = false) => {
    const pane = panes[id];
    if (pane.selected.size === 0) return;
    requestConfirm(
      t(
        pane.kind === 'local'
          ? permanent
            ? 'confirm.deletePermanentSelected'
            : 'confirm.recycleSelected'
          : 'confirm.deleteRemoteSelected',
        {
          count: pane.selected.size,
        },
      ),
      async () => {
        const backend = backendFor(pane, client);
        const names = [...pane.selected].filter((name) =>
          pane.entries.some((e) => e.name === name),
        );
        await mapWithConcurrency(names, DELETE_CONCURRENCY_LIMIT, async (name) => {
          const entry = pane.entries.find((e) => e.name === name)!;
          const res = await backend.remove(paneJoin(pane, name), entry.isDirectory, permanent);
          if (!res.ok) reportError(commandResultError(res));
        });
        refreshPane(id, pane.path, undefined, tabId);
      },
    );
  };

  const deletePaneEntry = (
    id: PaneId,
    entry: FileEntry,
    tabId = activeTabId,
    permanent = false,
  ) => {
    const pane = panes[id];
    requestConfirm(
      t(
        pane.kind === 'local'
          ? permanent
            ? 'confirm.deletePermanentEntry'
            : 'confirm.recycleEntry'
          : 'confirm.deleteRemoteEntry',
        {
          name: isolate(entry.name),
        },
      ),
      async () => {
        const res = await backendFor(pane, client).remove(
          paneJoin(pane, entry.name),
          entry.isDirectory,
          permanent,
        );
        if (!res.ok) reportError(commandResultError(res));
        refreshPane(id, pane.path, undefined, tabId);
      },
    );
  };

  const submitNewFolder = async (name: string, tabId: string, id: PaneId) => {
    const pane = panes[id];
    const res = await backendFor(pane, client).mkdir(paneJoin(pane, name));
    if (!res.ok) reportError(commandResultError(res));
    refreshPane(id, pane.path, undefined, tabId);
  };

  const submitNewFile = async (name: string, tabId: string, id: PaneId) => {
    const pane = panes[id];
    if (pane.kind === 'remote' && pane.entries.some((e) => e.name === name)) {
      reportError(t('errors.alreadyExists', { name: isolate(name) }));
      return;
    }
    const res = await backendFor(pane, client).createFile(paneJoin(pane, name));
    if (!res.ok) reportError(commandResultError(res));
    refreshPane(id, pane.path, undefined, tabId);
  };

  const chooseLocalDir = (id: PaneId) => async () => {
    const dir = await client.fsLocal.selectDir();
    if (typeof dir === 'string' && dir) navigatePane(id, dir);
  };

  const goPaneHome = (id: PaneId) => async () => {
    const home = await client.fsLocal.homedir();
    if (typeof home === 'string') navigatePane(id, home);
  };

  // Rename

  const renamePaneEntry = async (
    id: PaneId,
    entry: FileEntry,
    newName: string,
    tabId = activeTabId,
  ) => {
    const pane = panes[id];
    const res = await backendFor(pane, client).rename(
      paneJoin(pane, entry.name),
      paneJoin(pane, newName),
    );
    if (!res.ok) reportError(commandResultError(res));
    refreshPane(id, pane.path, undefined, tabId);
  };

  const movePaneSamePane = async (
    id: PaneId,
    names: readonly string[],
    targetFolder: string,
    tabId = activeTabId,
  ) => {
    const pane = panes[id];
    const backend = backendFor(pane, client);
    const targetDir = paneJoin(pane, targetFolder);
    for (const name of names) {
      const res = await backend.rename(
        paneJoin(pane, name),
        pane.kind === 'local' ? joinLocalPath(targetDir, name) : joinRemotePath(targetDir, name),
      );
      if (!res.ok) reportError(commandResultError(res));
    }
    refreshPane(id, pane.path, undefined, tabId);
  };

  return {
    deletePaneSelected,
    deletePaneEntry,
    submitNewFolder,
    submitNewFile,
    renamePaneEntry,
    movePaneSamePane,
    chooseLocalDir,
    goPaneHome,
  };
}
