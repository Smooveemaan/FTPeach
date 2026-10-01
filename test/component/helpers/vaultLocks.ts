import { vi } from 'vitest';
import { readyUnsubscribe } from '../../../src/platform/ipcContracts.ts';
import type { VaultLocked, VaultLockReason } from '../../../src/platform/ipcContracts.ts';

/**
 * The backend's side of `api.vault.onLocked`: hand `onLocked` to the mocked
 * vault API, then `announce` a lock the way `vault:locked` would.
 */
export function vaultLockEvents() {
  const listeners = new Set<(_locked: VaultLocked) => void>();
  return {
    onLocked: vi.fn((callback: (_locked: VaultLocked) => void) => {
      listeners.add(callback);
      return readyUnsubscribe(() => listeners.delete(callback));
    }),
    announce(reason: VaultLockReason) {
      for (const listener of [...listeners]) listener({ reason });
    },
    listening: () => listeners.size,
  };
}
