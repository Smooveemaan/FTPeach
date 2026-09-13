import { QUICKLIST_LIMIT } from '../../features/sites/index.ts';
import type { SettingsState } from '../../features/settings/index.ts';
import { updateSpeedSample } from '../../features/transfers/index.ts';
import type { SpeedSamples, TransferRow, TransferSummary } from '../../features/transfers/index.ts';
import type { TrayModel } from '../../platform/api/tray.ts';
import type { ManagedSite, Translate } from '../../shared/types.ts';

/** The speed limits the tray offers, in KB/s; 0 is no limit. */
export const SPEED_LIMIT_PRESETS_KBPS: readonly number[] = [0, 512, 1024, 5120, 10240];

export interface TrayModelInput {
  t: Translate;
  transfers: Pick<
    TransferSummary,
    'activeTransfersCount' | 'hasPausableTransfers' | 'canResumeAllTransfers'
  >;
  /** Overall progress of the running transfers, `null` when it is unknown. */
  progressPercent: number | null;
  /** Combined speed of the running transfers in bytes per second, `null` until measured. */
  speedBytesPerSecond: number | null;
  settings: Pick<
    SettingsState['transfers'],
    'transferSpeedLimitKBps' | 'preventSleepDuringTransfers' | 'notifyOnTransferComplete'
  >;
  /** Connectable sites, most recent first: the empty pane's order. */
  recentSites: readonly Pick<ManagedSite, 'id' | 'name'>[];
  vault: { configured: boolean; locked: boolean } | null;
  quit: { pending: boolean; promptOpen: boolean };
}

/** "512 KB/s", "5 MB/s", or no limit at all. */
export function formatSpeedLimit(t: Translate, kbps: number): string {
  if (kbps <= 0) return t('tray.unlimited');
  const megabytes = kbps / 1024;
  const value =
    kbps < 1024
      ? `${kbps} ${t('common.units.kb')}`
      : `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} ${t('common.units.mb')}`;
  return t('common.perSecond', { value });
}

const SPEED_UNIT_KEYS = [
  'common.units.kb',
  'common.units.mb',
  'common.units.gb',
  'common.units.tb',
] as const;

/** "850 B/s", "1.2 MB/s", "35 MB/s": how fast the transfers run right now. */
export function formatTransferSpeed(t: Translate, bytesPerSecond: number): string {
  let value = Math.max(0, bytesPerSecond);
  if (value < 1024) {
    return t('common.perSecond', { value: `${Math.round(value)} ${t('common.units.byte')}` });
  }
  let unit = 0;
  value /= 1024;
  while (value >= 1024 && unit < SPEED_UNIT_KEYS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return t('common.perSecond', {
    value: `${value.toFixed(value < 10 ? 1 : 0)} ${t(SPEED_UNIT_KEYS[unit]!)}`,
  });
}

export function buildTrayModel({
  t,
  transfers,
  progressPercent,
  speedBytesPerSecond,
  settings,
  recentSites,
  vault,
  quit,
}: TrayModelInput): TrayModel {
  // The backend takes a whole, non-negative number; a limit typed in Settings
  // that no preset matches gets a checked entry of its own, under "No limit".
  const speedLimit = Math.max(0, Math.round(settings.transferSpeedLimitKBps || 0));
  const [unlimited = 0, ...limits] = SPEED_LIMIT_PRESETS_KBPS;
  const presets = SPEED_LIMIT_PRESETS_KBPS.includes(speedLimit)
    ? SPEED_LIMIT_PRESETS_KBPS
    : [unlimited, speedLimit, ...limits];
  const active = transfers.activeTransfersCount;
  const numbers =
    progressPercent === null ? { count: active } : { count: active, percent: progressPercent };
  const statusKey = quit.pending
    ? progressPercent === null
      ? 'tray.quitWaiting'
      : 'tray.quitWaitingProgress'
    : progressPercent === null
      ? 'tray.transferring'
      : 'tray.transferringProgress';
  const status =
    speedBytesPerSecond === null
      ? t(statusKey, numbers)
      : `${t(statusKey, numbers)} · ${formatTransferSpeed(t, speedBytesPerSecond)}`;
  return {
    labels: {
      show: t('tray.show'),
      quit: t('tray.quit'),
      cancelQuit: t('tray.cancelQuit'),
      pauseAll: t('tray.pauseAll'),
      resumeAll: t('tray.resumeAll'),
      speedLimit: t('tray.speedLimit'),
      preventSleep: t('tray.preventSleep'),
      notify: t('tray.notify'),
      recentConnections: t('tray.recentConnections'),
      lockVault: t('tray.lockVault'),
    },
    status: active === 0 ? '' : status,
    transfers: {
      active,
      canPauseAll: transfers.hasPausableTransfers,
      canResumeAll: transfers.canResumeAllTransfers,
    },
    speedLimitKBps: speedLimit,
    speedPresets: presets.map((kbps) => ({ kbps, label: formatSpeedLimit(t, kbps) })),
    preventSleep: settings.preventSleepDuringTransfers,
    notifyOnComplete: settings.notifyOnTransferComplete,
    recentSites: recentSites
      .slice(0, QUICKLIST_LIMIT)
      .map((site) => ({ id: site.id, label: site.name })),
    vaultLockable: !!vault && vault.configured && !vault.locked,
    quitPending: quit.pending,
    quitPromptOpen: quit.promptOpen,
  };
}

const RUNNING: ReadonlySet<TransferRow['status']> = new Set(['queued', 'progress', 'cancelling']);

/**
 * Bytes done across the running transfers, as a whole percentage. A single
 * transfer whose size is still unknown makes the whole figure unknown, since
 * a percentage of what is known would jump back once that size arrives.
 */
export function transfersProgressPercent(rows: Iterable<TransferRow>): number | null {
  let bytes = 0;
  let total = 0;
  for (const row of rows) {
    if (!RUNNING.has(row.status)) continue;
    if (row.total === undefined || !Number.isFinite(row.total) || row.total < 0) return null;
    bytes += Math.min(Math.max(0, row.bytes), row.total);
    total += row.total;
  }
  if (total <= 0) return null;
  return Math.min(100, Math.floor((bytes / total) * 100));
}

/**
 * Measures the combined speed of the running transfers the way the transfer
 * list measures each row, from the byte counts seen at each call. Returns
 * `null` until at least one transfer has a speed.
 */
export function createTransfersSpeedMeter(
  now: () => number = () => performance.now(),
): (rows: Iterable<TransferRow>) => number | null {
  const samples: SpeedSamples = {};
  return (rows) => {
    const time = now();
    const running = new Set<string>();
    let total: number | null = null;
    for (const row of rows) {
      if (row.status !== 'progress') continue;
      running.add(row.id);
      const speed = updateSpeedSample(samples, row.id, row.bytes, row.status, time);
      if (speed !== null) total = (total ?? 0) + speed;
    }
    for (const id of Object.keys(samples)) {
      if (!running.has(id)) delete samples[id];
    }
    return total;
  };
}

/**
 * The part of a model that decides which items the menu has and how they
 * read: everything but the status line's changing numbers.
 */
export function trayMenuStructure(model: TrayModel): string {
  return JSON.stringify({ ...model, status: model.status !== '' });
}

export interface TrayModelSender {
  /** The inputs changed: a new menu goes out now, new numbers once a second. */
  update: () => void;
  /** Only progress moved: rebuild at the next allowed moment. */
  tick: () => void;
  dispose: () => void;
}

/**
 * Sends tray models without flooding IPC: a change to the menu's items goes
 * out at once, progress at most once per `interval`, and a model identical to
 * the last one sent never goes out. Driven by events rather than a repeating
 * timer, which Chromium throttles hard in a hidden window.
 */
export function createTrayModelSender({
  build,
  send,
  interval = 1000,
  now = Date.now,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
}: {
  build: () => TrayModel;
  send: (model: TrayModel) => void;
  interval?: number;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): TrayModelSender {
  let lastJson: string | undefined;
  let lastStructure: string | undefined;
  let lastSentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };

  function update(): void {
    if (disposed) return;
    const model = build();
    const json = JSON.stringify(model);
    if (json === lastJson) {
      clearTimer();
      return;
    }
    const structure = trayMenuStructure(model);
    const elapsed = now() - lastSentAt;
    if (structure !== lastStructure || elapsed >= interval) {
      clearTimer();
      lastJson = json;
      lastStructure = structure;
      lastSentAt = now();
      send(model);
      return;
    }
    timer ??= schedule(flush, interval - elapsed);
  }

  function flush(): void {
    timer = undefined;
    update();
  }

  return {
    update,
    tick: () => {
      if (disposed || timer !== undefined) return;
      timer = schedule(flush, Math.max(0, interval - (now() - lastSentAt)));
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
