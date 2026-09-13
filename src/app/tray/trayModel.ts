import type { TransferRow, TransferSummary } from '../../features/transfers/index.ts';
import type { TrayModel } from '../../platform/api/tray.ts';
import type { Translate } from '../../shared/types.ts';

export interface TrayModelInput {
  t: Translate;
  transfers: Pick<
    TransferSummary,
    'activeTransfersCount' | 'hasPausableTransfers' | 'canResumeAllTransfers'
  >;
  /** Overall progress of the running transfers, `null` when it is unknown. */
  progressPercent: number | null;
  vault: { configured: boolean; locked: boolean } | null;
}

export function buildTrayModel({
  t,
  transfers,
  progressPercent,
  vault,
}: TrayModelInput): TrayModel {
  const active = transfers.activeTransfersCount;
  const status =
    active === 0
      ? ''
      : progressPercent === null
        ? t('tray.transferring', { count: active })
        : t('tray.transferringProgress', { count: active, percent: progressPercent });
  return {
    labels: {
      show: t('tray.show'),
      quit: t('tray.quit'),
      pauseAll: t('tray.pauseAll'),
      resumeAll: t('tray.resumeAll'),
      lockVault: t('tray.lockVault'),
    },
    status,
    transfers: {
      active,
      canPauseAll: transfers.hasPausableTransfers,
      canResumeAll: transfers.canResumeAllTransfers,
    },
    vaultLockable: !!vault && vault.configured && !vault.locked,
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
