export type TransferColumnKey =
  | 'direction'
  | 'file'
  | 'route'
  | 'size'
  | 'transferred'
  | 'progress'
  | 'speed'
  | 'remaining'
  | 'status'
  | 'actions';
export type ResizableColumnKey = Exclude<TransferColumnKey, 'actions' | 'direction'>;
/** Direction stays first and actions stays last; data columns can be reordered. */
export type ReorderableColumnKey = ResizableColumnKey;
export type ColumnWidths = Partial<Record<TransferColumnKey, number>>;

export const DEFAULT_COLUMN_ORDER: ReorderableColumnKey[] = [
  'route',
  'file',
  'size',
  'transferred',
  'progress',
  'speed',
  'remaining',
  'status',
];
export const COLUMN_LABEL_KEY: Record<ReorderableColumnKey, string> = {
  file: 'transferQueue.columns.file',
  route: 'transferQueue.columns.route',
  size: 'transferQueue.columns.size',
  transferred: 'transferQueue.columns.transferred',
  progress: 'transferQueue.columns.progress',
  speed: 'transferQueue.columns.speed',
  remaining: 'transferQueue.columns.remaining',
  status: 'transferQueue.columns.status',
};
export const COLUMN_CLASS: Record<ReorderableColumnKey, string> = {
  file: 'col-file',
  route: 'col-route',
  size: 'col-size',
  transferred: 'col-transferred',
  progress: 'col-progress',
  speed: 'col-speed',
  remaining: 'col-remaining',
  status: 'col-status',
};

/** Drops unknown/duplicate entries from a persisted order and puts back any
 * reorderable column missing from it, so a stale or hand-edited setting can
 * never hide a column outright. A missing column goes back right after the
 * column it follows by default, so one added in a newer version turns up
 * where it belongs rather than at the far end of an order saved before it. */
export function sanitizeColumnOrder(order: readonly string[] | undefined): ReorderableColumnKey[] {
  const known = new Set<string>(DEFAULT_COLUMN_ORDER);
  const cleaned: ReorderableColumnKey[] = [];
  for (const key of order ?? []) {
    if (known.has(key) && !cleaned.includes(key as ReorderableColumnKey)) {
      cleaned.push(key as ReorderableColumnKey);
    }
  }
  DEFAULT_COLUMN_ORDER.forEach((key, index) => {
    if (cleaned.includes(key)) return;
    const previous = index === 0 ? undefined : DEFAULT_COLUMN_ORDER[index - 1];
    cleaned.splice(previous === undefined ? 0 : cleaned.indexOf(previous) + 1, 0, key);
  });
  return cleaned;
}

// Keep the original total width budget for the default 1180px window,
// giving names and routes more room by tightening numeric/action columns.
// File also receives spare viewport width until explicitly resized.
// Speed and remaining retain room for their longer translated headings.
export const COLUMN_DEFAULT_WIDTHS: Record<TransferColumnKey, number> = {
  direction: 14,
  file: 202,
  route: 160,
  size: 76,
  transferred: 88,
  progress: 150,
  speed: 110,
  remaining: 86,
  status: 118,
  actions: 44,
};
export const COLUMN_MIN_WIDTHS: Record<ResizableColumnKey, number> = {
  file: 140,
  route: 72,
  size: 72,
  transferred: 82,
  progress: 150,
  speed: 76,
  remaining: 66,
  status: 88,
};
/** "File" keeps room for its icon + filename regardless of its own short
 * label, and "Progress" keeps room for its bar rather than its label — both
 * stay on the fixed table above. Every other resizable column's minimum
 * instead comes from its own label's rendered width (below), so a column
 * can never be resized narrower than its own heading reads. */
export const LABEL_DRIVEN_MIN_WIDTH_KEYS = new Set<ResizableColumnKey>([
  'route',
  'size',
  'transferred',
  'speed',
  'remaining',
]);
