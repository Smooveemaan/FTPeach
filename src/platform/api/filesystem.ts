import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  checkedResponse,
  commandFailure,
  commandOutcome,
  hasCommandOutcome,
  isRecord,
} from '../ipcContracts.ts';
import type { InvokeFn } from '../ipcContracts.ts';
import type { CommandResult } from '../ipcContracts.ts';
import type { FileEntry } from '../../shared/types.ts';
import { reportAsyncFailure } from '../../shared/asyncFailure.ts';

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

function isFileEntry(value: unknown): value is FileEntry {
  return isRecord(value) && typeof value.name === 'string';
}

function isFilesystemListResult(value: unknown): value is FilesystemListResult {
  return (
    hasCommandOutcome(value) &&
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

const isOptionalPath = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

export function createFilesystemApi(invoke: InvokeFn) {
  // A cancelled native dialog and a failed one are the same thing to every
  // caller — no path was chosen — so these normalize to null instead of
  // widening every call site with a CommandResult.
  const selection = (command: string) =>
    checkedResponse(command, invoke(command), isOptionalPath, () => null);

  return {
    list: (localPath?: string): Promise<FilesystemListResult> =>
      checkedResponse(
        'fs_list',
        invoke('fs_list', { localPath }),
        isFilesystemListResult,
        (raw) => ({ ...commandFailure('fs_list', raw), path: localPath ?? '', entries: [] }),
      ),
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
    mkdir: (localPath: string) => commandOutcome(invoke, 'fs_mkdir', { localPath }),
    rename: (oldPath: string, newPath: string) =>
      commandOutcome(invoke, 'fs_rename', { oldPath, newPath }),
    copyFile: (sourcePath: string, destPath: string, overwrite = false) =>
      commandOutcome(invoke, 'fs_copy_file', { sourcePath, destPath, overwrite }),
    validateCopy: (sourcePath: string, destPath: string) =>
      commandOutcome(invoke, 'fs_validate_copy', { sourcePath, destPath }),
    delete: (localPath: string, permanent = false) =>
      commandOutcome(invoke, 'fs_delete', { localPath, permanent }),
    createFile: (localPath: string) => commandOutcome(invoke, 'fs_create_file', { localPath }),
    revealPath: (localPath: string) => commandOutcome(invoke, 'fs_reveal_path', { localPath }),
    openDocument: (localPath: string) => commandOutcome(invoke, 'fs_open_document', { localPath }),
    executePath: (localPath: string) => commandOutcome(invoke, 'fs_execute_path', { localPath }),
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
