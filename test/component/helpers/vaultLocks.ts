import { vi } from 'vitest';
import { readyUnsubscribe } from '../../../src/platform/ipcContracts.ts';
import type { VaultLocked, VaultLockReason } from '../../../src/platform/ipcContracts.ts';

/**
 * The backend's side of `api.vault.onLocked` and `onUnlocked`: hand both to
 * the mocked vault API, then `announce` a lock the way `vault:locked` would,
 * or `announceUnlocked` as `vault:unlocked` would.
 */
export function vaultLockEvents() {
  const listeners = new Set<(_locked: VaultLocked) => void>();
  const unlockListeners = new Set<() => void>();
  return {
    onUnlocked: vi.fn((callback: () => void) => {
      unlockListeners.add(callback);
      return readyUnsubscribe(() => unlockListeners.delete(callback));
    }),
    announceUnlocked() {
      for (const listener of [...unlockListeners]) listener();
    },
    onLocked: vi.fn((callback: (_locked: VaultLocked) => void) => {
      listeners.add(callback);
      return readyUnsubscribe(() => listeners.delete(callback));
    }),
    announce(reason: VaultLockReason) {
      for (const listener of [...listeners]) listener({ reason });
    },
    listening: () => listeners.size + unlockListeners.size,
  };
}
