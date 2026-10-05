import { useEffect, useState } from 'react';
import { api } from '../platform/api/index.ts';

type VaultApi = Pick<typeof api.vault, 'status' | 'onLocked' | 'onUnlocked'>;

type VaultState = { configured: boolean; locked: boolean } | null;

/**
 * Whether the vault is set up and whether it is locked; `null` until read.
 * It is read again when the backend announces a lock or an unlock, and when
 * the page is shown or hidden, which a lock on minimizing goes with.
 */
export function useVaultState(vaultApi: VaultApi = api.vault): VaultState {
  const [vault, setVault] = useState<VaultState>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      vaultApi.status().then(
        ({ configured, locked }) => {
          if (cancelled) return;
          setVault((previous) =>
            previous?.configured === configured && previous.locked === locked
              ? previous
              : { configured, locked },
          );
        },
        // An unreadable status keeps the last one; a lock button is no
        // place to report it.
        () => undefined,
      );
    };
    refresh();
    const stopLocked = vaultApi.onLocked(refresh);
    const stopUnlocked = vaultApi.onUnlocked(refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      stopLocked();
      stopUnlocked();
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [vaultApi]);
  return vault;
}
