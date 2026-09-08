import type { MutableRefObject, MouseEvent as ReactMouseEvent } from 'react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useColumnDragReorder } from '../../../hooks/useColumnDragReorder.ts';
import { useColumnResize } from '../../../hooks/useColumnResize.ts';
import { getInterfaceScale } from '../../../platform/interfaceScale.ts';
import type { FileEntry } from '../../../shared/types.ts';
import { useDateFormatter } from '../../settings/index.ts';
import type { ColumnKey, SortKey, Translate } from './fileListModel.ts';
import { COLUMN_DEFS, MIN_COLUMN_WIDTH, NAME_DEFAULT_WIDTH, isColumnKey } from './fileListModel.ts';

type ColumnWidths = Record<string, number>;

interface FileColumnsOptions {
  availableColumns: readonly ColumnKey[];
  visibleColumns: readonly ColumnKey[];
  onVisibleColumnsChange?: ((columns: ColumnKey[]) => void) | undefined;
  columnWidths: ColumnWidths;
  onColumnWidthsChange?: ((widths: ColumnWidths) => void) | undefined;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  nameAscExplicit: boolean;
  rows: readonly FileEntry[];
  columnLabels: Record<ColumnKey, string>;
  t: Translate;
}

interface AutoWidenRecord {
  key: SortKey;
  originalWidth: number;
  widenedWidth: number;
}

let measureCanvasCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string, font: string, letterSpacing: string): number {
  if (!measureCanvasCtx) measureCanvasCtx = document.createElement('canvas').getContext('2d');
  if (!measureCanvasCtx) return 0;
  measureCanvasCtx.font = font;
  if ('letterSpacing' in measureCanvasCtx) measureCanvasCtx.letterSpacing = letterSpacing || '0px';
  return measureCanvasCtx.measureText(text).width;
}

// Icon size (10) + .sort-indicator's own margin-inline-start (3px), from
// panes.css. Reserved for every sortable column's minimum width — even one
// that isn't the active sort key right now — so it's never left too narrow
// for the chevron once it becomes the sort column.
const SORT_INDICATOR_RESERVE_PX = 13;

/**
 * A column's minimum width: its own label's *natural* text width, plus room
 * for the sort-indicator chevron, plus .col-header's own end padding.
 *
 * Deliberately measures the label string through canvas rather than reading
 * a live `.col-header-label` element's `getBoundingClientRect()`: that span
 * is a shrinkable flex child with no `flex-shrink: 0`, so once the column
 * had already been narrowed, the element's own reported width was whatever
 * it had been *compressed* down to — not what its content actually needed.
 * Sizing off that stale, self-referential number under-widened the column
 * when a sort was later applied, clipping the chevron down to a sliver.
 */
function computeLabelMinWidth(
  label: string,
  font: string,
  letterSpacing: string,
  scale: number,
): number {
  const textWidth = measureTextWidth(label, font, letterSpacing);
  return Math.max(MIN_COLUMN_WIDTH, Math.ceil(textWidth / scale) + 8 + SORT_INDICATOR_RESERVE_PX);
}

export interface FileColumnsModel {
  activeColumns: (
    'size' | 'modifiedAt' | 'group' | 'createdAt' | 'type' | 'permissions' | 'owner'
  )[];
  widthOf: (key: SortKey) => number;
  gridTemplateColumns: string;
  rowGridTemplateColumns: string;
  draggedColumn: string | null;
  getDragHandleProps: (key: string) => {
    'data-column-key': string;
    'data-dragging': 'true' | undefined;
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  suppressColumnClickRef: MutableRefObject<boolean>;
  registerHeaderRef: (key: string) => (element: HTMLElement | null) => void;
  nameHeaderRef: MutableRefObject<HTMLElement | null>;
  toggleColumn: (key: ColumnKey) => void;
  resetColumnWidths: () => void | undefined;
  autoFitColumn: (key: SortKey) => (e: ReactMouseEvent<HTMLElement>) => void;
  startColumnResize: (key: SortKey) => (e: ReactMouseEvent<HTMLElement>) => void;
}

export default function useFileColumns({
  availableColumns,
  visibleColumns,
  onVisibleColumnsChange,
  columnWidths,
  onColumnWidthsChange,
  sortKey,
  sortDir,
  nameAscExplicit,
  rows: sorted,
  columnLabels: COLUMN_LABELS,
  t,
}: FileColumnsOptions): FileColumnsModel {
  const formatDate = useDateFormatter();
  const nameHeaderRef = useRef<HTMLElement | null>(null);
  const autoWidenRef = useRef<AutoWidenRecord | null>(null);
  const prevIndicatorKeyRef = useRef<SortKey | null>(null);

  const activeColumns = useMemo(
    () => visibleColumns.filter((key) => availableColumns.includes(key)),
    [visibleColumns, availableColumns],
  );
  // `columnWidths` is keyed by column name and comes from settings, so a width
  // can simply be missing — that is the one lookup here that still needs a
  // fallback, and the default it falls back to is now compiler-checked.
  const widthOf = (key: SortKey): number =>
    columnWidths[key] || (key === 'name' ? NAME_DEFAULT_WIDTH : COLUMN_DEFS[key].defaultWidth);
  const columnTracks = activeColumns.map((key) => `${widthOf(key)}px`).join(' ');
  const gridTemplateColumns = `20px ${widthOf('name')}px ${columnTracks} 1fr`;
  const rowGridTemplateColumns = `20px ${widthOf('name')}px ${columnTracks}`;

  const {
    draggedColumn,
    registerHeaderRef,
    getDragHandleProps,
    suppressClickRef: suppressColumnClickRef,
    refreshRects,
    headerElements: colHeaderRefs,
  } = useColumnDragReorder({
    order: activeColumns,
    // The reorder hook hit-tests against `data-column-key` read off the DOM, so
    // it works in plain strings and hands back plain strings. What comes back is
    // always a permutation of `activeColumns`, but only this filter says so in
    // a way the compiler can check.
    onReorder:
      onVisibleColumnsChange &&
      ((next: string[]) => onVisibleColumnsChange(next.filter(isColumnKey))),
  });
  const { startColumnResize: startResize } = useColumnResize();

  const columnWidthsKey = `${widthOf('name')},${availableColumns.map(widthOf).join(',')}`;
  useLayoutEffect(() => {
    refreshRects();
    // `refreshRects` closes over the current header elements and is rebuilt on
    // every render, so depending on it would re-measure on every render.
    // `columnWidthsKey` is the serialized width set — the only input that can
    // actually invalidate a measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnWidthsKey]);

  useLayoutEffect(() => {
    const indicatorKey =
      sortKey === 'name' && sortDir === 'asc' && !nameAscExplicit ? null : sortKey;
    const prevKey = prevIndicatorKeyRef.current;
    prevIndicatorKeyRef.current = indicatorKey;
    if (!onColumnWidthsChange) return;

    let nextWidths: ColumnWidths | null = null;
    const pending = () => nextWidths || (nextWidths = { ...columnWidths });

    if (prevKey && prevKey !== indicatorKey) {
      const record = autoWidenRef.current;
      if (record && record.key === prevKey && widthOf(prevKey) === record.widenedWidth) {
        pending()[prevKey] = record.originalWidth;
      }
      autoWidenRef.current = null;
    }

    if (indicatorKey) {
      const headerEl =
        indicatorKey === 'name' ? nameHeaderRef.current : colHeaderRefs.current.get(indicatorKey);
      if (headerEl) {
        const headerCs = getComputedStyle(headerEl);
        const label =
          indicatorKey === 'name' ? t('filePane.columnName') : COLUMN_LABELS[indicatorKey];
        const needed = computeLabelMinWidth(
          label,
          headerCs.font,
          headerCs.letterSpacing,
          getInterfaceScale(),
        );
        const current = widthOf(indicatorKey);
        if (needed > current) {
          autoWidenRef.current = {
            key: indicatorKey,
            originalWidth: current,
            widenedWidth: needed,
          };
          pending()[indicatorKey] = needed;
        }
      }
    }

    // `pending()` assigns `nextWidths` from inside a closure, which the
    // compiler does not follow — it still sees the `null` initialiser here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (nextWidths) onColumnWidthsChange(nextWidths);
    // This effect writes `columnWidths` (auto-widening the sorted column so its
    // sort arrow fits) from values it also reads. Listing `columnWidths`,
    // `widthOf` or `onColumnWidthsChange` here would make each write retrigger
    // the effect that made it. Only a change of sort indicator should move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, sortDir, nameAscExplicit]);

  // Columns without an explicit saved width fall back to a static,
  // language-agnostic `defaultWidth` (see COLUMN_DEFS). That default was
  // tuned for English labels, so it can render narrower than a column's own
  // label actually needs in a longer language (e.g. Russian) — clipping the
  // header — while sitting wider than necessary in a shorter one. Whenever
  // the set of "unset" (default-width) columns changes — on mount, right
  // after Resetting layout, or when the app language changes — widen any of
  // them that don't fit their current label. Never touches a column the
  // user has explicitly resized.
  const unsetColumnsKey = ['name', ...activeColumns]
    .filter((key) => columnWidths[key] === undefined)
    .join(',');
  const columnLabelsKey = `${t('filePane.columnName')}|${activeColumns
    .map((key) => COLUMN_LABELS[key])
    .join('|')}`;
  useLayoutEffect(() => {
    if (!onColumnWidthsChange) return;

    let nextWidths: ColumnWidths | null = null;
    const pending = () => nextWidths || (nextWidths = { ...columnWidths });
    const scale = getInterfaceScale();

    const checkColumn = (key: SortKey, label: string, headerEl: HTMLElement | null) => {
      if (columnWidths[key] !== undefined) return;
      if (!headerEl) return;
      const headerCs = getComputedStyle(headerEl);
      const needed = computeLabelMinWidth(label, headerCs.font, headerCs.letterSpacing, scale);
      const current = widthOf(key);
      if (needed > current) pending()[key] = needed;
    };

    checkColumn('name', t('filePane.columnName'), nameHeaderRef.current);
    for (const key of activeColumns) {
      checkColumn(key, COLUMN_LABELS[key], colHeaderRefs.current.get(key) ?? null);
    }

    // `pending()` assigns `nextWidths` from inside a closure, which the
    // compiler does not follow — it still sees the `null` initialiser here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (nextWidths) onColumnWidthsChange(nextWidths);
    // Same self-feeding write as the effect above: it widens default-width
    // columns from the widths it reads. The two keys already encode exactly
    // what should retrigger it — which columns are still at their default, and
    // what their labels currently say in the active language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsetColumnsKey, columnLabelsKey]);

  const toggleColumn = (key: ColumnKey) => {
    if (!onVisibleColumnsChange) return;
    const next = visibleColumns.includes(key)
      ? visibleColumns.filter((k) => k !== key)
      : [...visibleColumns, key];
    onVisibleColumnsChange(next);
  };

  const resetColumnWidths = () => onColumnWidthsChange && onColumnWidthsChange({});

  const autoFitColumn = (key: SortKey) => (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const headerEl = e.currentTarget.parentElement;
    if (!headerEl) return;

    const headerCs = getComputedStyle(headerEl);
    const label = key === 'name' ? t('filePane.columnName') : COLUMN_LABELS[key];
    let maxWidth = measureTextWidth(label, headerCs.font, headerCs.letterSpacing);

    const paneEl = headerEl.closest('.pane');
    const sampleCell = paneEl?.querySelector(
      key === 'name' ? '.pane-list .row .name' : `.pane-list .row .col-${key}`,
    );
    const cellFont = sampleCell ? getComputedStyle(sampleCell).font : headerCs.font;
    const cellLetterSpacing = sampleCell
      ? getComputedStyle(sampleCell).letterSpacing
      : headerCs.letterSpacing;

    const values =
      key === 'name'
        ? sorted.map((entry) => entry.name)
        : sorted.map((entry) => COLUMN_DEFS[key].render(entry, t, formatDate));
    for (const text of values) {
      if (!text) continue;
      const w = measureTextWidth(text, cellFont, cellLetterSpacing);
      if (w > maxWidth) maxWidth = w;
    }

    const nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.ceil(maxWidth) + 16);
    onColumnWidthsChange && onColumnWidthsChange({ ...columnWidths, [key]: nextWidth });
  };

  const startColumnResize = (key: SortKey) => (e: ReactMouseEvent<HTMLElement>) => {
    suppressColumnClickRef.current = true;
    const headerEl = e.currentTarget.parentElement;
    const scale = getInterfaceScale();
    const label = key === 'name' ? t('filePane.columnName') : COLUMN_LABELS[key];
    const headerCs = headerEl && getComputedStyle(headerEl);
    const minWidth = headerCs
      ? computeLabelMinWidth(label, headerCs.font, headerCs.letterSpacing, scale)
      : MIN_COLUMN_WIDTH;
    startResize({
      startWidth: widthOf(key),
      minWidth,
      onResize: (nextWidth) => onColumnWidthsChange?.({ ...columnWidths, [key]: nextWidth }),
      onResizeEnd: refreshRects,
    })(e);
  };

  return {
    activeColumns,
    widthOf,
    gridTemplateColumns,
    rowGridTemplateColumns,
    draggedColumn,
    getDragHandleProps,
    suppressColumnClickRef,
    registerHeaderRef,
    nameHeaderRef,
    toggleColumn,
    resetColumnWidths,
    autoFitColumn,
    startColumnResize,
  };
}
