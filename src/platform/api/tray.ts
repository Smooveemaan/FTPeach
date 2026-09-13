import { isRecord } from '../ipcContracts.ts';
import type { EventRegistrar, InvokeFn } from '../ipcContracts.ts';

/**
 * What the tray icon shows. The renderer owns the queue, settings and vault,
 * so every string arrives finished and localized; the backend only draws it.
 */
export interface TrayModel {
  labels: {
    show: string;
    quit: string;
    cancelQuit: string;
    pauseAll: string;
    resumeAll: string;
    speedLimit: string;
    preventSleep: string;
    notify: string;
    recentConnections: string;
    lockVault: string;
  };
  /** The finished status line, empty while nothing is transferring. */
  status: string;
  transfers: { active: number; canPauseAll: boolean; canResumeAll: boolean };
  /** A whole number; one of the presets always matches it. */
  speedLimitKBps: number;
  /** 0 is no limit. Labels are formatted here, not in the backend. */
  speedPresets: { kbps: number; label: string }[];
  preventSleep: boolean;
  notifyOnComplete: boolean;
  /** Most recent first, at most three. */
  recentSites: { id: string; label: string }[];
  /** The vault is set up and unlocked. */
  vaultLockable: boolean;
  /** Quitting waits for the running transfers to finish. */
  quitPending: boolean;
  /**
   * The window is asking whether to quit. The backend takes a model saying so
   * as the answer to its request; without one it assumes the window is gone.
   */
  quitPromptOpen: boolean;
}

/** A tray menu click, or a quit request, the renderer carries out. */
export type TrayAction =
  | { kind: 'pauseAll' }
  | { kind: 'resumeAll' }
  | { kind: 'setSpeedLimit'; kbps: number }
  | { kind: 'setPreventSleep'; enabled: boolean }
  | { kind: 'setNotifyOnComplete'; enabled: boolean }
  | { kind: 'connect'; siteId: string }
  | { kind: 'lockVault' }
  | { kind: 'quitRequested' }
  | { kind: 'cancelQuit' };

const BARE_ACTIONS: ReadonlySet<string> = new Set([
  'pauseAll',
  'resumeAll',
  'lockVault',
  'quitRequested',
  'cancelQuit',
]);

export function isTrayAction(value: unknown): value is TrayAction {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'setSpeedLimit':
      return typeof value.kbps === 'number' && Number.isSafeInteger(value.kbps) && value.kbps >= 0;
    case 'setPreventSleep':
    case 'setNotifyOnComplete':
      return typeof value.enabled === 'boolean';
    case 'connect':
      return typeof value.siteId === 'string';
    default:
      return BARE_ACTIONS.has(value.kind);
  }
}

export function createTrayApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    setModel: (model: TrayModel) => invoke('tray_set_model', { model }),
    hideWindow: () => invoke('tray_hide_window'),
    onAction: onEvent('tray:action', isTrayAction),
  };
}
