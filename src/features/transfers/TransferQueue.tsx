import TransferItemRow from './components/TransferItemRow.tsx';
import { STATUS_TAG_KEYS } from './transferPresentation.ts';
import {
  sanitizeColumnOrder,
  COLUMN_LABEL_KEY,
  COLUMN_CLASS,
  COLUMN_DEFAULT_WIDTHS,
  COLUMN_MIN_WIDTHS,
  LABEL_DRIVEN_MIN_WIDTH_KEYS,
} from './transferColumns.ts';
import type {
  TransferColumnKey,
  ResizableColumnKey,
  ReorderableColumnKey,
  ColumnWidths,
} from './transferColumns.ts';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, MouseEvent, ReactNode, UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../components/Icon.tsx';
import { useTruncated } from '../../hooks/useTruncated.ts';
import { useColumnDragReorder } from '../../hooks/useColumnDragReorder.ts';
import { useColumnResize } from '../../hooks/useColumnResize.ts';
import { getInterfaceScale } from '../../platform/interfaceScale.ts';
import { getTransfersSnapshot, subscribeTransfers } from './transferStore.ts';
import type { SpeedSamples } from './transferSpeed.ts';
import {
  TRANSFER_HEADER_HEIGHT,
  TRANSFER_HEADER_HEIGHT_NARROW,
} from '../../shared/layoutMetrics.ts';

interface TransferQueueProps {
  onRetry: (id: string) => void;
  onPause: (id: string) => void;
  onStop: (id: string) => void;
  onClearCompleted: () => void;
  height?: number | undefined;
  narrow?: boolean | undefined;
  widthRatio?: number | undefined;
  columnWidths?: ColumnWidths | undefined;
  onColumnWidthsChange?: ((widths: ColumnWidths) => void) | undefined;
  columnOrder?: string[] | undefined;
  onColumnOrderChange?: ((order: string[]) => void) | undefined;
}

let transferMeasureCtx: CanvasRenderingContext2D | null = null;
function measureLabelWidth(text: string, font: string, letterSpacing: string): number {
  if (!transferMeasureCtx) transferMeasureCtx = document.createElement('canvas').getContext('2d');
  if (!transferMeasureCtx) return 0;
  transferMeasureCtx.font = font;
  if ('letterSpacing' in transferMeasureCtx)
    transferMeasureCtx.letterSpacing = letterSpacing || '0px';
  // The header renders its label through `text-transform: uppercase`
  // (transfers.css); canvas measurement doesn't apply CSS, so match it by
  // hand or the measured width would undershoot an all-caps render.
  return transferMeasureCtx.measureText(text.toUpperCase()).width;
}

/** The "Status" column's minimum must fit whichever status pill is widest,
 * not just its own header label — the Russian "Paused"/"DOWNLOAD"-style pills
 * routinely outrun a short "Status" heading. Reads the pill's real font and
 * padding off a currently-rendered `.status-tag` when one exists (so narrow
 * mode's smaller font/padding is picked up automatically); falls back to
 * the base (non-narrow) CSS values from transfers.css when the queue is
 * empty and no sample element exists yet. */
function measureStatusColumnMinWidth(t: (key: string) => string, scale: number): number {
  const sample = document.querySelector<HTMLElement>('.transfer-item .status-tag');
  const sampleCs = sample && getComputedStyle(sample);
  const font = sampleCs?.font || '700 10px sans-serif';
  const letterSpacing = sampleCs?.letterSpacing || '0.05em';
  const paddingX = sampleCs
    ? parseFloat(sampleCs.paddingLeft) + parseFloat(sampleCs.paddingRight)
    : 12;

  let maxTextWidth = 0;
  for (const key of STATUS_TAG_KEYS) {
    const width = measureLabelWidth(t(key), font, letterSpacing);
    if (width > maxTextWidth) maxTextWidth = width;
  }
  return Math.ceil((maxTextWidth + paddingX) / scale);
}

interface HeaderCellProps {
  label: ReactNode;
  className: string;
  columnKey: TransferColumnKey;
  reorderable: boolean;
  dragging: boolean;
  registerRef?: ((element: HTMLElement | null) => void) | undefined;
  onDragMouseDown?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  onResizeStart?: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
  onResizeReset?: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
}

function HeaderCell({
  label,
  className,
  columnKey,
  reorderable,
  dragging,
  registerRef,
  onDragMouseDown,
  onResizeStart,
  onResizeReset,
}: HeaderCellProps) {
  const [truncatedRef, truncated] = useTruncated<HTMLDivElement>([label]);
  return (
    <div
      ref={(element) => {
        truncatedRef.current = element;
        registerRef?.(element);
      }}
      data-column-key={columnKey}
      data-reorderable={reorderable ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      className={`${className} transfer-resizable-header${truncated ? ' truncated' : ''}`}
      onMouseDown={onDragMouseDown}
    >
      {label}
      {onResizeStart && (
        <span
          className="col-resize-handle"
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeReset}
        />
      )}
    </div>
  );
}

export default function TransferQueue({
  onRetry,
  onPause,
  onStop,
  onClearCompleted,
  height,
  narrow,
  widthRatio,
  columnWidths = {},
  onColumnWidthsChange,
  columnOrder,
  onColumnOrderChange,
}: TransferQueueProps) {
  const { t } = useTranslation();
  const [, tickStalledSpeeds] = useReducer((n: number) => n + 1, 0);
  const transfers = useSyncExternalStore(subscribeTransfers, getTransfersSnapshot);
  const items = useMemo(
    () => Object.values(transfers).sort((a, b) => a.startedAt - b.startedAt),
    [transfers],
  );
  const hasProgress = items.some((item) => item.status === 'progress');
  useEffect(() => {
    if (!hasProgress) return;
    const timer = window.setInterval(tickStalledSpeeds, 1000);
    return () => window.clearInterval(timer);
  }, [hasProgress]);
  const hasCompleted = items.some(
    (item) => item.status === 'done' || item.status === 'error' || item.status === 'stopped',
  );
  const speedSamples = useRef<SpeedSamples>({}).current;
  const colHeaderRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousIdsRef = useRef<Set<string> | null>(null);
  const unseenIdsRef = useRef(new Set<string>());
  const nearBottomRef = useRef(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const columnOrderFull = useMemo(() => sanitizeColumnOrder(columnOrder), [columnOrder]);
  const visibleReorderableKeys = useMemo(
    () => columnOrderFull.filter((key) => !narrow || (key !== 'speed' && key !== 'remaining')),
    [columnOrderFull, narrow],
  );
  const visibleColumnKeys: TransferColumnKey[] = ['file', ...visibleReorderableKeys, 'actions'];
  const widthOf = (key: TransferColumnKey): number =>
    columnWidths[key] || COLUMN_DEFAULT_WIDTHS[key];
  const gridTemplateColumns = `${visibleColumnKeys.map((key) => `${widthOf(key)}px`).join(' ')} minmax(0, 1fr)`;

  const { draggedColumn, registerHeaderRef, getDragHandleProps, refreshRects } =
    useColumnDragReorder({
      order: columnOrderFull,
      onReorder: onColumnOrderChange,
    });
  const { startColumnResize: startResize } = useColumnResize();

  const columnWidthsKey = visibleColumnKeys.map((key) => widthOf(key)).join(',');
  useLayoutEffect(() => {
    refreshRects();
    // As in useFileColumns: `refreshRects` is rebuilt every render, so it cannot
    // be a dependency without re-measuring every render. `columnWidthsKey` is
    // the serialized width set, which is what actually invalidates the rects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnWidthsKey]);

  const startColumnResize = (key: ResizableColumnKey) => (event: MouseEvent<HTMLSpanElement>) => {
    if (!onColumnWidthsChange) return;
    let minWidth = COLUMN_MIN_WIDTHS[key];
    if (LABEL_DRIVEN_MIN_WIDTH_KEYS.has(key)) {
      const headerEl = event.currentTarget.parentElement;
      if (headerEl) {
        const scale = getInterfaceScale();
        const cs = getComputedStyle(headerEl);
        const label = t(COLUMN_LABEL_KEY[key as ReorderableColumnKey]);
        const textWidth = measureLabelWidth(label, cs.font, cs.letterSpacing);
        // +8 mirrors .transfer-resizable-header's own end padding (transfers.css) —
        // the same reserved-gap accounting the file browser's column headers use.
        // The floor only guards a canvas-measurement failure (e.g. a headless
        // test environment without 2d context support), not real labels.
        minWidth = Math.max(24, Math.ceil(textWidth / scale) + 8);
        // "Status" also has to fit whichever status pill is widest — a data
        // cell, not the header, so it doesn't carry that same +8 (no resize
        // handle sits over it) but can still exceed the header label's own
        // width once a long status pill (e.g. the Russian "Paused") is measured.
        if (key === 'status') {
          minWidth = Math.max(minWidth, measureStatusColumnMinWidth(t, scale));
        }
      }
    }
    startResize({
      startWidth: widthOf(key),
      minWidth,
      onResize: (nextWidth) => onColumnWidthsChange({ ...columnWidths, [key]: nextWidth }),
      onResizeEnd: refreshRects,
    })(event);
  };

  const resetColumnWidth = (key: ResizableColumnKey) => (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const next = { ...columnWidths };
    delete next[key];
    onColumnWidthsChange?.(next);
  };

  const headerCell = (key: ResizableColumnKey, label: ReactNode, className: string) => {
    const reorderable = key !== 'file';
    const dragHandleProps = reorderable ? getDragHandleProps(key) : null;
    return (
      <HeaderCell
        key={key}
        columnKey={key}
        label={label}
        className={className}
        reorderable={reorderable}
        dragging={draggedColumn === key}
        registerRef={reorderable ? registerHeaderRef(key) : undefined}
        onDragMouseDown={dragHandleProps?.onMouseDown}
        onResizeStart={onColumnWidthsChange ? startColumnResize(key) : undefined}
        onResizeReset={onColumnWidthsChange ? resetColumnWidth(key) : undefined}
      />
    );
  };
  const scrollToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    nearBottomRef.current = true;
    unseenIdsRef.current.clear();
    setUnseenCount(0);
  };

  const itemIdsKey = items.map((item) => item.id).join('|');
  useLayoutEffect(() => {
    const currentIds = new Set(items.map((item) => item.id));
    const previousIds = previousIdsRef.current;
    previousIdsRef.current = currentIds;

    // Rows removed by "Clear completed" must not remain in the badge count.
    for (const id of unseenIdsRef.current) {
      if (!currentIds.has(id)) unseenIdsRef.current.delete(id);
    }

    if (previousIds == null) {
      // Opening an already-populated queue starts at its chronological end.
      scrollToLatest();
      return;
    }

    const added = items.filter((item) => !previousIds.has(item.id));
    if (added.length > 0) {
      if (nearBottomRef.current) {
        scrollToLatest();
        return;
      }
      for (const item of added) unseenIdsRef.current.add(item.id);
    }
    setUnseenCount(unseenIdsRef.current.size);
    // itemIdsKey deliberately ignores progress ticks: only structural queue
    // changes can create/remove unseen rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIdsKey]);

  const handleListScroll = (e: UIEvent<HTMLDivElement>) => {
    const list = e.currentTarget;
    if (colHeaderRef.current) colHeaderRef.current.scrollLeft = list.scrollLeft;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 32;
    nearBottomRef.current = nearBottom;
    if (nearBottom && unseenIdsRef.current.size > 0) {
      unseenIdsRef.current.clear();
      setUnseenCount(0);
    }
  };
  const rootStyle: CSSProperties =
    widthRatio != null ? { flex: `${widthRatio} 1 0%`, minWidth: 0 } : { flex: `0 0 ${height}px` };

  const isCollapsed =
    height != null && height <= (narrow ? TRANSFER_HEADER_HEIGHT_NARROW : TRANSFER_HEADER_HEIGHT);

  return (
    <div
      className={`transfer-queue ${narrow ? 'narrow' : ''}`}
      style={rootStyle}
      data-column-reorder-scope
    >
      <div className="section-panel-header transfer-queue-header">
        <span>{t('transferQueue.title')}</span>
        <span className="transfer-queue-header-right">
          {/* Matches the log panel's own icon-only treatment (see
              LogPanel.tsx) in both narrow and full layouts now, rather than
              switching to a text label once there's room to spare. */}
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-tooltip={t('menu.transfer.clearCompleted')}
            onClick={onClearCompleted}
            disabled={!hasCompleted}
          >
            <Icon name="broom" size={12} />
          </button>
        </span>
      </div>
      {!isCollapsed && items.length > 0 && (
        <div
          className="transfer-cols transfer-col-header"
          ref={colHeaderRef}
          style={{ gridTemplateColumns }}
        >
          {headerCell('file', t('transferQueue.columns.file'), 'col-file')}
          {visibleReorderableKeys.map((key) =>
            headerCell(key, t(COLUMN_LABEL_KEY[key]), COLUMN_CLASS[key]),
          )}
          <div className="col-actions" />
          <div className="col-filler" />
        </div>
      )}
      <div className="transfer-list" ref={listRef} onScroll={handleListScroll}>
        {!isCollapsed && items.length === 0 && (
          <div className="transfer-empty">{t('transferQueue.empty')}</div>
        )}
        {!isCollapsed &&
          items.map((item) => (
            <TransferItemRow
              key={item.id}
              item={item}
              columnOrder={visibleReorderableKeys}
              gridTemplateColumns={gridTemplateColumns}
              speedSamples={speedSamples}
              onRetry={onRetry}
              onPause={onPause}
              onStop={onStop}
            />
          ))}
      </div>
      {unseenCount > 0 && (
        <button type="button" className="transfer-new-items" onClick={scrollToLatest}>
          <Icon name="arrowDown" size={11} />
          {t('transferQueue.newTransfers', { count: unseenCount })}
        </button>
      )}
    </div>
  );
}
