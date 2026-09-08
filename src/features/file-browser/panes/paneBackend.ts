import { joinLocalPath, joinRemotePath } from '../../../shared/paths.ts';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import type { FileEntry } from '../../../shared/types.ts';
import type { PaneState } from './paneModel.ts';
import { api } from '../../../platform/api/index.ts';

export interface PaneBackend {
  list: (path?: string) => Promise<CommandResult & { path?: string; entries: FileEntry[] }>;
  mkdir: (path: string) => Promise<CommandResult>;
  createFile: (path: string) => Promise<CommandResult>;
  remove: (path: string, isDir: boolean, permanent?: boolean) => Promise<CommandResult>;
  rename: (oldPath: string, newPath: string) => Promise<CommandResult>;
}

export function backendFor(
  pane: PaneState,
  client: Pick<Window['api'], 'fsLocal' | 'session'> = api,
): PaneBackend {
  if (pane.kind === 'local') {
    return {
      list: (path) => client.fsLocal.list(path),
      mkdir: (path) => client.fsLocal.mkdir(path),
      createFile: (path) => client.fsLocal.createFile(path),
      remove: (path, _isDir, permanent = false) => client.fsLocal.delete(path, permanent),
      rename: (oldPath, newPath) => client.fsLocal.rename(oldPath, newPath),
    };
  }

  if (!pane.connectionId) throw new Error('Remote pane has no active connection');
  const connectionId = pane.connectionId;
  return {
    list: (path) => client.session.list(connectionId, path ?? '/'),
    mkdir: (path) => client.session.mkdir(connectionId, path),
    createFile: (path) => client.session.createFile(connectionId, path),
    remove: (path, isDir) => client.session.delete(connectionId, path, isDir),
    rename: (oldPath, newPath) => client.session.rename(connectionId, oldPath, newPath),
  };
}

export const paneJoin = (pane: PaneState, name: string): string =>
  pane.kind === 'local' ? joinLocalPath(pane.path, name) : joinRemotePath(pane.path, name);
