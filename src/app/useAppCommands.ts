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
  if (event.code === 'F12') return 'open-devtools';
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
        if (event.defaultPrevented || isTextEditingShortcut(event)) return;
        const action = resolveGlobalAction(event, keyboardShortcutsRef.current);
        if (!action) return;
        const handled = dispatchAppCommand(action, commandsRef.current);
        if (handled) event.preventDefault();
      }),
    [shortcutsApi],
  );
}
