import { useEffect, useRef } from 'react';
import { api } from '../platform/api/index.ts';
import type { ShortcutOverrides } from '../shortcuts/resolve.ts';
import { resolveAction } from '../shortcuts/resolve.ts';
import { isTextEditingShortcut } from '../shortcuts/textInput.ts';

interface AppCommands {
  modalOpen: boolean;
  openDevtools: () => unknown;
  [action: string]: unknown;
}
interface ShortcutsApi {
  onKeyDown: (callback: (event: KeyboardEvent) => void) => () => void;
}

export function dispatchAppCommand(action: string, commands: AppCommands): boolean {
  if (action === 'open-devtools') {
    commands.openDevtools();
    return true;
  }
  if (commands.modalOpen) return false;
  const handler = commands[action];
  if (!handler) return false;
  if (typeof handler !== 'function') return false;
  // The command table is indexed with `unknown` values; narrowing to `function`
  // gets us as far as `Function`, which is not callable without this.
  (handler as () => unknown)();
  return true;
}

function resolveGlobalAction(event: KeyboardEvent, keyboardShortcuts?: ShortcutOverrides | null) {
  if (
    event.code === 'F12' ||
    (event.altKey && event.metaKey && !event.ctrlKey && !event.shiftKey && event.code === 'KeyI')
  ) {
    return 'open-devtools';
  }
  return resolveAction(event, 'global', keyboardShortcuts);
}

export function useAppCommands(
  commands: AppCommands,
  keyboardShortcuts?: ShortcutOverrides | null,
  shortcutsApi: ShortcutsApi = api.shortcuts,
): void {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const keyboardShortcutsRef = useRef(keyboardShortcuts);
  keyboardShortcutsRef.current = keyboardShortcuts;

  useEffect(
    () =>
      shortcutsApi.onKeyDown((event) => {
        if (event.defaultPrevented) return;
        // Let the embedded SSH terminal claim Ctrl+C/R/W/F/N/T/F5 etc.; only
        // DevTools and tab switching escape out to the application.
        if (
          event.target instanceof Element &&
          event.target.closest('[data-terminal-input="true"]')
        ) {
          const action = resolveGlobalAction(event, keyboardShortcutsRef.current);
          if (action === 'open-devtools' || action === 'next-tab' || action === 'prev-tab') {
            const handled = dispatchAppCommand(action, commandsRef.current);
            if (handled) event.preventDefault();
          }
          return;
        }
        if (isTextEditingShortcut(event)) return;
        // This listener captures, so it runs before a recorder can claim the keys.
        if (event.target instanceof Element && event.target.closest('.shortcut-recorder.recording'))
          return;
        // The window's own select-all would take the log and every label;
        // only the file panes (and text fields, above) select with Ctrl+A.
        if (
          event.code === 'KeyA' &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !(event.target instanceof Element && event.target.closest('.pane'))
        )
          event.preventDefault();
        // Prevent browser default actions that treat the window like a web page:
        // reload (Cmd/Ctrl+R), print (Cmd/Ctrl+P), and browser in-page find (Cmd/Ctrl+F).
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (event.code === 'KeyR' || event.code === 'KeyP' || event.code === 'KeyF')
        )
          event.preventDefault();
        const action = resolveGlobalAction(event, keyboardShortcutsRef.current);
        if (!action) return;
        const handled = dispatchAppCommand(action, commandsRef.current);
        if (handled) event.preventDefault();
      }),
    [shortcutsApi],
  );
}
