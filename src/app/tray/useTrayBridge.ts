import { useEffect, useRef, useState } from 'react';
import { getTransfersSnapshot, subscribeTransfers } from '../../features/transfers/index.ts';
import { api } from '../../platform/api/index.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import type { Translate } from '../../shared/types.ts';
import { buildTrayModel, createTrayModelSender, transfersProgressPercent } from './trayModel.ts';
import type { TrayModelInput, TrayModelSender } from './trayModel.ts';

type TrayApi = Pick<typeof api.tray, 'setModel' | 'onAction'>;
type VaultApi = Pick<typeof api.vault, 'status' | 'lock'>;

export interface TrayBridgeOptions {
  t: Translate;
  transfers: TrayModelInput['transfers'];
  pauseAllTransfers: () => void;
  resumeAllTransfers: () => void;
  trayApi?: TrayApi;
  vaultApi?: VaultApi;
}

/**
 * Keeps the tray icon's menu in step with the window and carries out what is
 * clicked in it. The renderer stays the source of truth: the backend only
 * draws the model it is sent and reports clicks back as `tray:action`, which
 * are handled by the same functions the window's own controls call.
 */
export function useTrayBridge({
  t,
  transfers,
  pauseAllTransfers,
  resumeAllTransfers,
  trayApi = api.tray,
  vaultApi = api.vault,
}: TrayBridgeOptions): void {
  const vault = useVaultState(vaultApi);

  const inputRef = useRef({ t, transfers, vault });
  inputRef.current = { t, transfers, vault };
  const senderRef = useRef<TrayModelSender | null>(null);
  useEffect(() => {
    const sender = createTrayModelSender({
      build: () => {
        const input = inputRef.current;
        return buildTrayModel({
          ...input,
          progressPercent:
            input.transfers.activeTransfersCount > 0
              ? transfersProgressPercent(Object.values(getTransfersSnapshot()))
              : null,
        });
      },
      send: (model) => reportRejection(trayApi.setModel(model)),
    });
    senderRef.current = sender;
    sender.update();
    const unsubscribe = subscribeTransfers(sender.tick);
    return () => {
      unsubscribe();
      sender.dispose();
      senderRef.current = null;
    };
  }, [trayApi]);

  const { activeTransfersCount, hasPausableTransfers, canResumeAllTransfers } = transfers;
  useEffect(() => {
    senderRef.current?.update();
  }, [t, activeTransfersCount, hasPausableTransfers, canResumeAllTransfers, vault]);

  const actionsRef = useRef({ pauseAllTransfers, resumeAllTransfers });
  actionsRef.current = { pauseAllTransfers, resumeAllTransfers };
  useEffect(
    () =>
      trayApi.onAction((action) => {
        const actions = actionsRef.current;
        switch (action.kind) {
          case 'pauseAll':
            actions.pauseAllTransfers();
            return;
          case 'resumeAll':
            actions.resumeAllTransfers();
            return;
          case 'lockVault':
            reportRejection(
              vaultApi.lock().then((result) => {
                // The same announcement as the automatic lock: revealed
                // secrets are cleared and the tray drops the lock item.
                if (result.ok !== false) window.dispatchEvent(new Event('ftpeach:vault-locked'));
              }),
            );
            return;
        }
      }),
    [trayApi, vaultApi],
  );
}

type VaultState = { configured: boolean; locked: boolean } | null;

/**
 * The vault's state as far as the tray cares. It is read again whenever the
 * page is hidden, which is when the icon appears: the vault may have been set
 * up or unlocked in the window in the meantime, and nothing announces that.
 */
function useVaultState(vaultApi: VaultApi): VaultState {
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
        // An unreadable status keeps the last one; the tray is no place to
        // report it.
        () => undefined,
      );
    };
    refresh();
    window.addEventListener('ftpeach:vault-locked', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('ftpeach:vault-locked', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [vaultApi]);
  return vault;
}
