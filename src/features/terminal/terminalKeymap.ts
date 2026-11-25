import type { Platform } from '../../platform/os.ts';

export type TerminalKeyAction =
  'copy' | 'paste' | 'select-all' | 'clear' | 'pass-through-app' | 'prevent-browser' | 'pty';

export interface TerminalKeyInput {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Decides how a keydown inside the terminal is handled on each OS.
 *
 * - Windows / Linux: smart Ctrl+C copies when text is selected and sends SIGINT
 *   to the PTY when nothing is selected; Ctrl+V pastes; Ctrl+Shift+C/V and
 *   Ctrl+Insert / Shift+Insert always copy and paste.
 * - macOS: Cmd+C/V/A/K operate on the terminal UI, while Ctrl+C/R/W/D/Z/L go
 *   straight to the PTY.
 * - Ctrl+Tab / Ctrl+Shift+Tab and DevTools shortcuts always escape to the app.
 */
export function classifyTerminalKey(
  event: TerminalKeyInput,
  platform: Platform,
  hasSelection = false,
): TerminalKeyAction {
  const { code, key, ctrlKey, metaKey, altKey, shiftKey } = event;

  if (
    code === 'F12' ||
    (platform === 'macos' && altKey && metaKey && !ctrlKey && !shiftKey && code === 'KeyI')
  ) {
    return 'pass-through-app';
  }
  if (ctrlKey && !metaKey && !altKey && (code === 'Tab' || key === 'Tab')) {
    return 'pass-through-app';
  }
  const zoomMod =
    platform === 'macos' ? metaKey && !ctrlKey && !altKey : ctrlKey && !metaKey && !altKey;
  if (
    zoomMod &&
    (code === 'Equal' ||
      (!shiftKey &&
        (code === 'Minus' ||
          code === 'Digit0' ||
          code === 'NumpadAdd' ||
          code === 'NumpadSubtract' ||
          code === 'Numpad0')))
  ) {
    return 'pass-through-app';
  }

  if (platform === 'macos') {
    if (metaKey && !ctrlKey && !altKey && !shiftKey) {
      if (code === 'KeyC') return 'copy';
      if (code === 'KeyV') return 'paste';
      if (code === 'KeyA') return 'select-all';
      if (code === 'KeyK') return 'clear';
      if (code === 'KeyF' || code === 'KeyR' || code === 'KeyP' || code === 'KeyS') {
        return 'prevent-browser';
      }
    }
    return 'pty';
  }

  // Windows & Linux
  if (ctrlKey && shiftKey && !altKey && !metaKey) {
    if (code === 'KeyC') return 'copy';
    if (code === 'KeyV') return 'paste';
  }
  if (ctrlKey && !shiftKey && !altKey && !metaKey) {
    if (code === 'KeyC' && hasSelection) return 'copy';
    if (code === 'KeyV') return 'paste';
    if (code === 'Insert') return 'copy';
  }
  if (shiftKey && !ctrlKey && !altKey && !metaKey && code === 'Insert') {
    return 'paste';
  }

  return 'pty';
}
