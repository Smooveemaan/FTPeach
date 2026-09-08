export type TransferColumnKey =
  'file' | 'size' | 'transferred' | 'progress' | 'speed' | 'remaining' | 'status' | 'actions';
export type ResizableColumnKey = Exclude<TransferColumnKey, 'actions'>;
/** The columns a drag can reorder — "File" stays pinned first (like the file
 * browser's "Name") and "Actions" stays pinned last (it has no header label
 * to grab in the first place). */
export type ReorderableColumnKey = Exclude<ResizableColumnKey, 'file'>;
export type ColumnWidths = Partial<Record<TransferColumnKey, number>>;

export const DEFAULT_COLUMN_ORDER: ReorderableColumnKey[] = [
  'size',
  'transferred',
  'progress',
  'speed',
  'remaining',
  'status',
];
export const COLUMN_LABEL_KEY: Record<ReorderableColumnKey, string> = {
  size: 'transferQueue.columns.size',
  transferred: 'transferQueue.columns.transferred',
  progress: 'transferQueue.columns.progress',
  speed: 'transferQueue.columns.speed',
  remaining: 'transferQueue.columns.remaining',
  status: 'transferQueue.columns.status',
};
export const COLUMN_CLASS: Record<ReorderableColumnKey, string> = {
  size: 'col-size',
  transferred: 'col-transferred',
  progress: 'col-progress',
  speed: 'col-speed',
  remaining: 'col-remaining',
  status: 'col-status',
};

/** Drops unknown/duplicate entries from a persisted order and appends any
 * reorderable column missing from it, so a stale or hand-edited setting can
 * never hide a column outright. */
export function sanitizeColumnOrder(order: readonly string[] | undefined): ReorderableColumnKey[] {
  const known = new Set<string>(DEFAULT_COLUMN_ORDER);
  const seen = new Set<string>();
  const cleaned: ReorderableColumnKey[] = [];
  for (const key of order ?? []) {
    if (known.has(key) && !seen.has(key)) {
      seen.add(key);
      cleaned.push(key as ReorderableColumnKey);
    }
  }
  for (const key of DEFAULT_COLUMN_ORDER) {
    if (!seen.has(key)) cleaned.push(key);
  }
  return cleaned;
}

// Sized so the 8 columns' defaults (plus their 10px gaps and this row's own
// 24px inline padding) never exceed the transfer list's available width at
// the app's default 1180px window — verified against every supported
// locale's translated header label (the longest, German's "Geschwindigkeit"
// for "speed" and Swedish's "Återstående" for "remaining", drove those two
// numbers up from a purely English-tuned guess) so no language forces the
// row into horizontal scrolling by default.
export const COLUMN_DEFAULT_WIDTHS: Record<TransferColumnKey, number> = {
  file: 300,
  size: 90,
  transferred: 100,
  progress: 180,
  speed: 110,
  remaining: 86,
  status: 118,
  actions: 60,
};
export const COLUMN_MIN_WIDTHS: Record<ResizableColumnKey, number> = {
  file: 140,
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
  'size',
  'transferred',
  'speed',
  'remaining',
  'status',
]);
