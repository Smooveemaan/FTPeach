// What Windows says about the application's windows (windows.ps1), and the
// close message Alt+F4 sends, for what a page cannot see or do about itself.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface NativeWindow {
  handle: number;
  visible: boolean;
  minimized: boolean;
  /** Owned by another window: the confirmation window is owned by the main one. */
  owned: boolean;
  /** The page area's width and height in physical pixels. */
  client: [number, number];
}

const script = path.join(import.meta.dirname, 'windows.ps1');
const run = (...args: string[]) =>
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    {
      encoding: 'utf8',
    },
  );

export const nativeWindows = (pid: number): NativeWindow[] =>
  run('list', String(pid))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NativeWindow);

/** Asks a window to close, as Alt+F4 would. */
export const closeWindow = (pid: number, handle: number) => {
  run('close', String(pid), '-Handle', String(handle));
};

/** Sets a window's outer size in physical pixels; a program's resize is not held to its minimum. */
export const resizeWindow = (pid: number, handle: number, width: number, height: number) => {
  run('resize', ...[pid, '-Handle', handle, '-Width', width, '-Height', height].map(String));
};
