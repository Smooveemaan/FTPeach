import { formatBytes, formatDuration, formatSpeed } from '../../shared/format.ts';
import type { Translate } from '../../shared/types.ts';
import type { ResizableColumnKey } from './transferColumns.ts';
import type { TransferRow } from './transferStore.ts';
import { transferDisplayName, transferRoutePlaces } from './transferPresentation.ts';

/** Measure all data in short slices, without mounting offscreen React rows. */
export async function measureTransferDataWidth(
  rows: readonly TransferRow[],
  key: ResizableColumnKey,
  list: HTMLElement,
  label: (id: string) => string,
  t: Translate,
  speeds: ReadonlyMap<string, number | null>,
  cancelled: () => boolean,
): Promise<number> {
  if (key === 'status' || key === 'progress') return 0; // Fixed bar / finite localized status set.
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 0;
  const selector = key === 'file' ? '.t-name' : `[data-column-cell="${key}"]`;
  const sample = list.querySelector(selector) ?? list;
  const style = getComputedStyle(sample);
  const subStyle = getComputedStyle(list.querySelector('.t-sub') ?? sample);
  const cache = new Map<string, number>();
  const measure = (text: string, sub = false) => {
    const font = sub ? subStyle.font : style.font;
    const cacheKey = `${font}:${text}`;
    let width = cache.get(cacheKey);
    if (width === undefined) {
      context.font = font;
      context.letterSpacing = (sub ? subStyle.letterSpacing : style.letterSpacing) || '0px';
      width = context.measureText(text).width;
      if (cache.size < 1000) cache.set(cacheKey, width);
    }
    return width;
  };
  let width = 0;
  let deadline = performance.now() + 4;
  for (const row of rows) {
    if (cancelled()) return 0;
    const speed = speeds.get(row.id) ?? null;
    let next = 0;
    if (key === 'file') {
      const sub =
        row.status === 'error'
          ? row.errorMessage
          : row.status === 'stopped'
            ? t('transferQueue.cancelledByUser')
            : '';
      next = Math.max(measure(transferDisplayName(row)), sub ? measure(sub, true) : 0) + 20;
    } else if (key === 'route') {
      const [from, to] = transferRoutePlaces(row, label, t);
      next = measure(from) + measure(to) + measure('→') + 16;
    } else {
      const text =
        key === 'size'
          ? formatBytes(row.total && row.total > 0 ? row.total : row.bytes)
          : key === 'transferred'
            ? formatBytes(row.bytes)
            : key === 'speed'
              ? formatSpeed(row.status === 'progress' ? speed : null)
              : formatDuration(
                  row.status === 'progress' && row.total && speed && speed > 0
                    ? (row.total - row.bytes) / speed
                    : null,
                );
      next = measure(text) + 8;
    }
    width = Math.max(width, next);
    if (performance.now() > deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      deadline = performance.now() + 4;
    }
  }
  return Math.ceil(width);
}
