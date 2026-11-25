import { useSyncExternalStore } from 'react';
import { terminalStore } from './terminalStore.ts';
import type { TerminalSessionSnapshot, TerminalStore } from './terminalStore.ts';

export function useTerminalSession(
  connectionId: string | null | undefined,
  store: TerminalStore = terminalStore,
): TerminalSessionSnapshot | null {
  const sessions = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!connectionId) return null;
  return sessions.get(connectionId) ?? null;
}
