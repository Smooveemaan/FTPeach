import { useEffect, useRef, useState } from 'react';
import type { SettingsUpdaters } from '../../features/settings/index.ts';
import { getTransfersSnapshot, subscribeTransfers } from '../../features/transfers/index.ts';
import { api } from '../../platform/api/index.ts';
import { persistSetting } from '../../platform/persistSetting.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import type { ManagedSite, PaneId, Translate } from '../../shared/types.ts';
import { buildTrayModel, createTrayModelSender, transfersProgressPercent } from './trayModel.ts';
import type { TrayModelInput, TrayModelSender } from './trayModel.ts';
import type { QuitWhenIdleModel } from '../quit/useQuitWhenIdle.ts';

type TrayApi = Pick<typeof api.tray, 'setModel' | 'onAction'>;
type VaultApi = Pick<typeof api.vault, 'status' | 'lock'>;

export interface TrayBridgeOptions {
  t: Translate;
  transfers: TrayModelInput['transfers'];
  pauseAllTransfers: () => void;
  resumeAllTransfers: () => void;
  quit: Pick<QuitWhenIdleModel, 'pending' | 'promptOpen' | 'request' | 'cancel'>;
  settings: TrayModelInput['settings'];
  updateTransfers: SettingsUpdaters['transfers'];
  /** Connectable sites, most recent first. */
  recentSites: TrayModelInput['recentSites'];
  connectableSites: readonly ManagedSite[];
  connectSavedSite: (site: ManagedSite, paneId?: PaneId) => void;
  freeConnectTargetPaneId: PaneId | null;
  trayApi?: TrayApi;
  vaultApi?: VaultApi;
  persist?: (patch: Record<string, unknown>) => void;
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
  quit,
  settings,
  updateTransfers,
  recentSites,
  connectableSites,
  connectSavedSite,
  freeConnectTargetPaneId,
  trayApi = api.tray,
  vaultApi = api.vault,
  persist = persistSetting,
}: TrayBridgeOptions): void {
  const vault = useVaultState(vaultApi);

  const { pending: quitPending, promptOpen: quitPromptOpen } = quit;
  const { transferSpeedLimitKBps, preventSleepDuringTransfers, notifyOnTransferComplete } =
    settings;
  const input = {
    t,
    transfers,
    settings: { transferSpeedLimitKBps, preventSleepDuringTransfers, notifyOnTransferComplete },
    recentSites,
    vault,
    quit: { pending: quitPending, promptOpen: quitPromptOpen },
  };
  const inputRef = useRef(input);
  inputRef.current = input;
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
  }, [
    t,
    activeTransfersCount,
    hasPausableTransfers,
    canResumeAllTransfers,
    transferSpeedLimitKBps,
    preventSleepDuringTransfers,
    notifyOnTransferComplete,
    recentSites,
    vault,
    quitPending,
    quitPromptOpen,
  ]);

  const actions = {
    pauseAllTransfers,
    resumeAllTransfers,
    quit,
    connectableSites,
    connectSavedSite,
    freeConnectTargetPaneId,
    // Settings changed from the tray go the way a toggle in the window does:
    // into the state at once, and to the store shortly after. The backend
    // applies the speed limit and sleep prevention as it stores them.
    changeTransfers: (patch: Partial<TrayModelInput['settings']>) => {
      updateTransfers(patch);
      persist(patch);
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
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
          case 'setSpeedLimit':
            actions.changeTransfers({ transferSpeedLimitKBps: action.kbps });
            return;
          case 'setPreventSleep':
            actions.changeTransfers({ preventSleepDuringTransfers: action.enabled });
            return;
          case 'setNotifyOnComplete':
            actions.changeTransfers({ notifyOnTransferComplete: action.enabled });
            return;
          case 'connect': {
            // The backend has already brought the window back. A site
            // deleted since the menu was drawn is simply not there.
            const site = actions.connectableSites.find((entry) => entry.id === action.siteId);
            if (site) actions.connectSavedSite(site, actions.freeConnectTargetPaneId ?? undefined);
            return;
          }
          case 'lockVault':
            reportRejection(
              vaultApi.lock().then((result) => {
                // The same announcement as the automatic lock: revealed
                // secrets are cleared and the tray drops the lock item.
                if (result.ok !== false) window.dispatchEvent(new Event('ftpeach:vault-locked'));
              }),
            );
            return;
          case 'quitRequested':
            actions.quit.request();
            return;
          case 'cancelQuit':
            actions.quit.cancel();
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
