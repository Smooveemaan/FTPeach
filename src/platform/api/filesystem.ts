import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  checkedResponse,
  commandFailure,
  isFileEntry,
  isRecord,
  voidOutcome,
} from '../ipcContracts.ts';
import type { InvokeFn } from '../ipcContracts.ts';
import type { CommandResult } from '../ipcContracts.ts';
import type { FileEntry } from '../../shared/paneContracts.ts';
import { reportAsyncFailure } from '../../shared/asyncFailure.ts';
import executableExtensions from '../../shared/executableExtensions.json' with { type: 'json' };

export interface FilesystemListResult extends CommandResult {
  path: string;
  entries: FileEntry[];
}

export interface OsDragDropPayload {
  type: string;
  paths: string[] | null;
  point: { x: number; y: number } | null;
}
export interface LocalDrive {
  path: string;
  label: string;
}
export interface SelectedSshKey {
  path: string;
  isRsa: boolean;
}

function onOsDragDrop(callback: (payload: OsDragDropPayload) => void) {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      const ratio = window.devicePixelRatio || 1;
      const position = 'position' in payload ? payload.position : null;
      const paths = 'paths' in payload ? payload.paths : null;
      const point = position ? { x: position.x / ratio, y: position.y / ratio } : null;
      callback({ type: payload.type, paths: paths || null, point });
    })
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    // Without this listener, dragging files in from Explorer silently does
    // nothing — a failure worth surfacing rather than swallowing.
    .catch(reportAsyncFailure);
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}

/** What `fs_list` answers when it worked. */
interface FilesystemList {
  path: string;
  entries: FileEntry[];
}

function isFilesystemList(value: unknown): value is FilesystemList {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.every(isFileEntry)
  );
}

function isLocalDrive(value: unknown): value is LocalDrive {
  return isRecord(value) && typeof value.path === 'string' && typeof value.label === 'string';
}

function isSelectedSshKey(value: unknown): value is SelectedSshKey {
  return isRecord(value) && typeof value.path === 'string' && typeof value.isRsa === 'boolean';
}

// The backend refuses the wrong one of the two commands, so both sides read
// the same list: src-tauri/src/local_fs/local_open.rs.
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set(executableExtensions);

const isOptionalPath = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

export function createFilesystemApi(invoke: InvokeFn) {
  // A cancelled native dialog and a failed one are the same thing to every
  // caller — no path was chosen — so these normalize to null instead of
  // widening every call site with a CommandResult.
  const selection = (command: string) =>
    checkedResponse(command, invoke(command), isOptionalPath, () => null);

  return {
    list: (
      localPath?: string,
      requestKey?: string,
      signal?: AbortSignal,
    ): Promise<FilesystemListResult> => {
      if (signal?.aborted)
        return Promise.resolve({
          ok: false,
          errorCode: 'cancelled',
          path: localPath ?? '',
          entries: [],
        });
      const cancel = () => {
        if (requestKey) void invoke('fs_cancel_list', { requestKey }).catch(reportAsyncFailure);
      };
      const result = checkedResponse(
        'fs_list',
        invoke('fs_list', { localPath, ...(requestKey ? { requestKey } : {}) }),
        isFilesystemList,
        (raw): FilesystemListResult => ({
          ...commandFailure('fs_list', raw),
          path: localPath ?? '',
          entries: [],
        }),
      ).then((listing) => ('ok' in listing ? listing : { ok: true, ...listing }));
      signal?.addEventListener('abort', cancel, { once: true });
      return result.finally(() => signal?.removeEventListener('abort', cancel));
    },
    homedir: (): Promise<string | null> =>
      checkedResponse(
        'fs_homedir',
        invoke('fs_homedir'),
        (value): value is string => typeof value === 'string' && value !== '',
        () => null,
      ),
    drives: (): Promise<LocalDrive[]> =>
      checkedResponse(
        'fs_drives',
        invoke('fs_drives'),
        (value): value is LocalDrive[] => Array.isArray(value) && value.every(isLocalDrive),
        () => [],
      ),
    mkdir: (localPath: string) => voidOutcome(invoke, 'fs_mkdir', { localPath }),
    rename: (oldPath: string, newPath: string, overwrite: boolean) =>
      voidOutcome(invoke, 'fs_rename', {
        oldPath,
        newPath,
        overwrite,
      }),
    copyFile: (sourcePath: string, destPath: string, overwrite = false) =>
      voidOutcome(invoke, 'fs_copy_file', { sourcePath, destPath, overwrite }),
    validateCopy: (sourcePath: string, destPath: string) =>
      voidOutcome(invoke, 'fs_validate_copy', { sourcePath, destPath }),
    delete: (localPath: string, permanent = false) =>
      voidOutcome(invoke, 'fs_delete', { localPath, permanent }),
    createFile: (localPath: string) => voidOutcome(invoke, 'fs_create_file', { localPath }),
    revealPath: (localPath: string) => voidOutcome(invoke, 'fs_reveal_path', { localPath }),
    openPath: (localPath: string) =>
      voidOutcome(
        invoke,
        EXECUTABLE_EXTENSIONS.has(localPath.split('.').pop()?.toLowerCase() ?? '')
          ? 'fs_execute_path'
          : 'fs_open_document',
        { localPath },
      ),
    selectDir: () => selection('dialog_select_local_dir'),
    selectKeyFile: (): Promise<SelectedSshKey | null> =>
      checkedResponse(
        'dialog_select_key_file',
        invoke('dialog_select_key_file'),
        (value): value is SelectedSshKey | null => value === null || isSelectedSshKey(value),
        () => null,
      ),
    selectCaCertFile: () => selection('dialog_select_ca_cert_file'),
    selectApplication: () => selection('dialog_select_application'),
    pathForFile: (file: File & { path?: string }) => file.path || null,
    isDir: (localPath: string): Promise<boolean> =>
      checkedResponse(
        'fs_is_dir',
        invoke('fs_is_dir', { localPath }),
        (value): value is boolean => typeof value === 'boolean',
        () => false,
      ),
    onOsDragDrop,
  };
}
