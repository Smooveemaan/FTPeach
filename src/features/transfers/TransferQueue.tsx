import { createPortal } from 'react-dom';
import ContextMenu from '../../components/ContextMenu.tsx';
import { updateSpeedSample } from './transferSpeed.ts';
import { transferRoutePlaces, transferDisplayName } from './transferPresentation.ts';
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
import type { TransferColumnKey, ResizableColumnKey, ColumnWidths } from './transferColumns.ts';
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
import {
  getTransfersSnapshot,
  rememberedConnectionLabel,
  subscribeTransfers,
} from './transferStore.ts';
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
  /** Open connections' names. Closed ones come from `rememberConnectionLabels`. */
  connectionLabels?: ReadonlyMap<string, string> | undefined;
  height?: number | undefined;
  narrow?: boolean | undefined;
  widthRatio?: number | undefined;
  columnWidths?: ColumnWidths | undefined;
  onColumnWidthsChange?: ((widths: ColumnWidths) => void) | undefined;
  columnOrder?: string[] | undefined;
  hiddenColumns?: string[] | undefined;
  onHiddenColumnsChange?: ((columns: string[]) => void) | undefined;
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
  active: boolean;
  descending: boolean;
  onSort: () => void;
  className: string;
  columnKey: TransferColumnKey;
  reorderable: boolean;
  dragging: boolean;
  registerRef?: ((element: HTMLElement | null) => void) | undefined;
  onDragMouseDown?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  onResizeStart?: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
  onResizeFit?: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
}

function HeaderCell({
  label,
  active,
  descending,
  onSort,
  className,
  columnKey,
  reorderable,
  dragging,
  registerRef,
  onDragMouseDown,
  onResizeStart,
  onResizeFit,
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
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSort}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSort();
        }
      }}
      onMouseDown={onDragMouseDown}
    >
      {label}
      {active && (
        <span className={`sort-indicator ${descending ? 'desc' : ''}`}>
          <Icon name="chevronUp" size={10} />
        </span>
      )}
      {onResizeStart && (
        <span
          className="col-resize-handle"
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeFit}
          onClick={(event) => event.stopPropagation()}
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
  connectionLabels,
  height,
  narrow,
  widthRatio,
  columnWidths = {},
  onColumnWidthsChange,
  columnOrder,
  onColumnOrderChange,
  hiddenColumns,
  onHiddenColumnsChange,
}: TransferQueueProps) {
  const { t } = useTranslation();
  const [, tickStalledSpeeds] = useReducer((n: number) => n + 1, 0);
  const transfers = useSyncExternalStore(subscribeTransfers, getTransfersSnapshot);
  const [sort, setSort] = useState<{ key: ResizableColumnKey | 'queue'; dir: 'asc' | 'desc' }>({
    key: 'queue',
    dir: 'asc',
  });
  const [localHidden, setLocalHidden] = useState<string[]>([]);
  const hidden = hiddenColumns ?? localHidden;
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const items = Object.values(transfers);
  const hasProgress = items.some((item) => item.status === 'progress');
  useEffect(() => {
    if (!hasProgress) return;
    const timer = window.setInterval(tickStalledSpeeds, 1000);
    return () => window.clearInterval(timer);
  }, [hasProgress]);
  const hasCompleted = items.some(
    (item) => item.status === 'done' || item.status === 'error' || item.status === 'stopped',
  );
  const connectionLabel = (connectionId: string): string =>
    connectionLabels?.get(connectionId) ?? rememberedConnectionLabel(connectionId) ?? '?';
  const speedSamples = useRef<SpeedSamples>({}).current;
  for (const id of Object.keys(speedSamples)) {
    if (!transfers[id]) delete speedSamples[id];
  }
  const speeds = new Map(
    items.map((item) => [
      item.id,
      updateSpeedSample(speedSamples, item.id, item.bytes, item.status),
    ]),
  );
  const statusPriority = {
    progress: 0,
    cancelling: 1,
    queued: 2,
    paused: 3,
    error: 4,
    stopped: 5,
    done: 6,
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const value = (item: (typeof items)[number]): string | number | null => {
    const speed = speeds.get(item.id) ?? null;
    switch (sort.key) {
      case 'file':
        return transferDisplayName(item);
      case 'route':
        return transferRoutePlaces(item, connectionLabel, t).join(' → ');
      case 'size':
        return item.total && item.total > 0 ? item.total : item.bytes;
      case 'transferred':
        return item.bytes;
      case 'progress':
        return item.total && item.total > 0 ? Math.min(1, item.bytes / item.total) : null;
      case 'speed':
        return speed;
      case 'remaining':
        return item.total && speed && speed > 0
          ? Math.max(0, item.total - item.bytes) / speed
          : null;
      case 'status':
      case 'queue':
        return statusPriority[item.status];
    }
  };
  const sortValues = new Map(items.map((item) => [item.id, value(item)]));
  items.sort((a, b) => {
    const av = sortValues.get(a.id) ?? null,
      bv = sortValues.get(b.id) ?? null;
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const comparison =
      typeof av === 'string' && typeof bv === 'string'
        ? collator.compare(av, bv)
        : ((av as number | null) ?? 0) - ((bv as number | null) ?? 0);
    return (
      comparison * (sort.dir === 'asc' ? 1 : -1) ||
      (sort.key === 'queue' ? b.startedAt - a.startedAt : a.startedAt - b.startedAt) ||
      a.id.localeCompare(b.id)
    );
  });
  const colHeaderRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const columnOrderFull = useMemo(() => sanitizeColumnOrder(columnOrder), [columnOrder]);
  const visibleReorderableKeys = useMemo(
    () =>
      columnOrderFull.filter(
        (key) => !hidden.includes(key) && (!narrow || (key !== 'speed' && key !== 'remaining')),
      ),
    [columnOrderFull, narrow, hidden],
  );
  const visibleColumnKeys: TransferColumnKey[] = [
    'direction',
    ...visibleReorderableKeys,
    'actions',
  ];
  const [defaultWidths, setDefaultWidths] = useState<ColumnWidths>({});
  const widthOf = (key: TransferColumnKey): number =>
    (key === 'direction'
      ? COLUMN_DEFAULT_WIDTHS.direction
      : columnWidths[key] || defaultWidths[key]) || COLUMN_DEFAULT_WIDTHS[key];
  const labelsKey = visibleReorderableKeys.map((key) => t(COLUMN_LABEL_KEY[key])).join('|');
  const statusLabelsKey = STATUS_TAG_KEYS.map((key) => t(key)).join('|');
  const hasRows = items.length > 0;
  const scale = getInterfaceScale();
  useLayoutEffect(() => {
    const next: ColumnWidths = {};
    for (const key of visibleReorderableKeys) {
      const header = colHeaderRef.current?.querySelector<HTMLElement>(`[data-column-key="${key}"]`);
      if (!header) continue;
      const cs = getComputedStyle(header);
      // Reserve the sort arrow and both paddings, even before a sort is selected.
      const padding =
        (parseFloat(cs.paddingInlineStart) || 0) + (parseFloat(cs.paddingInlineEnd) || 0);
      const labelWidth = measureLabelWidth(t(COLUMN_LABEL_KEY[key]), cs.font, cs.letterSpacing);
      next[key] = Math.max(
        COLUMN_DEFAULT_WIDTHS[key],
        Math.ceil((labelWidth + padding) / scale) + 13,
      );
      if (key === 'status') next[key] = Math.max(next[key], measureStatusColumnMinWidth(t, scale));
    }
    setDefaultWidths((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
    // These keys encode the visible labels and status pills; progress ticks must not measure layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsKey, statusLabelsKey, narrow, hasRows, scale, height]);
  const flexibleFile = visibleReorderableKeys.includes('file') && !columnWidths.file;
  const gridTemplateColumns = `${visibleColumnKeys
    .map((key) =>
      key === 'file' && flexibleFile ? `minmax(${widthOf(key)}px, 1fr)` : `${widthOf(key)}px`,
    )
    .join(' ')} ${flexibleFile ? '0px' : 'minmax(0, 1fr)'}`;

  const { draggedColumn, registerHeaderRef, getDragHandleProps, suppressClickRef, refreshRects } =
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

  const autoWidenRef = useRef<{
    key: ResizableColumnKey;
    originalWidth: number | undefined;
    widenedWidth: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!onColumnWidthsChange) return;
    const indicatorKey = sort.key === 'queue' ? null : sort.key;
    const nextWidths = { ...columnWidths };
    let changed = false;
    const record = autoWidenRef.current;
    if (record && record.key !== indicatorKey) {
      // Restore only our own adjustment, never a subsequent manual resize.
      if (columnWidths[record.key] === record.widenedWidth) {
        if (record.originalWidth === undefined) delete nextWidths[record.key];
        else nextWidths[record.key] = record.originalWidth;
        changed = true;
      }
      autoWidenRef.current = null;
    }
    if (indicatorKey) {
      const header = colHeaderRef.current?.querySelector<HTMLElement>(
        `[data-column-key="${indicatorKey}"]`,
      );
      if (header) {
        const cs = getComputedStyle(header);
        const padding =
          (parseFloat(cs.paddingInlineStart) || 0) + (parseFloat(cs.paddingInlineEnd) || 0);
        const labelWidth = measureLabelWidth(
          t(COLUMN_LABEL_KEY[indicatorKey]),
          cs.font,
          cs.letterSpacing,
        );
        const needed = Math.ceil((labelWidth + padding) / scale) + 13;
        const current = widthOf(indicatorKey);
        if (needed > current) {
          autoWidenRef.current = {
            key: indicatorKey,
            originalWidth:
              record?.key === indicatorKey && columnWidths[indicatorKey] === record.widenedWidth
                ? record.originalWidth
                : columnWidths[indicatorKey],
            widenedWidth: needed,
          };
          nextWidths[indicatorKey] = needed;
          changed = true;
        }
      }
    }
    if (changed) onColumnWidthsChange(nextWidths);
    // Match file panels: react to the indicator, not to the widths this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort.key, sort.dir, labelsKey, scale]);

  const widthsForManualResize = (): ColumnWidths => {
    if (!flexibleFile) return columnWidths;
    const fileHeader = colHeaderRef.current?.querySelector<HTMLElement>('[data-column-key="file"]');
    const renderedWidth = (fileHeader?.getBoundingClientRect().width ?? 0) / getInterfaceScale();
    // Freeze the flexible track before changing another column, otherwise
    // File absorbs its width delta and the divider appears to stand still.
    return { ...columnWidths, file: renderedWidth || widthOf('file') };
  };

  const startColumnResize = (key: ResizableColumnKey) => (event: MouseEvent<HTMLSpanElement>) => {
    if (!onColumnWidthsChange) return;
    const resizeWidths = widthsForManualResize();
    let minWidth = COLUMN_MIN_WIDTHS[key];
    if (LABEL_DRIVEN_MIN_WIDTH_KEYS.has(key)) {
      const headerEl = event.currentTarget.parentElement;
      if (headerEl) {
        const scale = getInterfaceScale();
        const cs = getComputedStyle(headerEl);
        const label = t(COLUMN_LABEL_KEY[key]);
        const textWidth = measureLabelWidth(label, cs.font, cs.letterSpacing);
        // Reserve 13px for the sort arrow plus 8px end padding —
        // the same reserved-gap accounting the file browser's column headers use.
        // The floor only guards a canvas-measurement failure (e.g. a headless
        // test environment without 2d context support), not real labels.
        minWidth = Math.max(24, Math.ceil(textWidth / scale) + 21);
        if (key === 'status') minWidth = Math.max(minWidth, measureStatusColumnMinWidth(t, scale));
      }
    }
    startResize({
      startWidth: resizeWidths[key] || widthOf(key),
      minWidth,
      onResize: (nextWidth) => onColumnWidthsChange({ ...resizeWidths, [key]: nextWidth }),
      onResizeEnd: refreshRects,
    })(event);
  };

  const fitColumnWidth = (key: ResizableColumnKey) => (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.parentElement;
    const list = listRef.current;
    if (!header || !list || !onColumnWidthsChange) return;
    const scale = getInterfaceScale();
    let width = COLUMN_MIN_WIDTHS[key];
    if (key === 'status') width = Math.max(width, measureStatusColumnMinWidth(t, scale));
    // A flexible bar has no intrinsic width. Keep a useful track length,
    // while still fitting localized headings and text-only progress states.
    if (key === 'progress') width = COLUMN_DEFAULT_WIDTHS.progress;

    // Measure max-content copies in the same CSS context: this includes the
    // actual fonts, icons, gaps, padding and secondary lines, even for rows
    // outside the scroll viewport. Batch insertion before reading layout.
    const sources = [
      header,
      ...list.querySelectorAll<HTMLElement>(
        key === 'file' ? '.t-file' : `[data-column-cell="${key}"]`,
      ),
    ];
    const probes = sources.map((source) => {
      const wrapper = source.parentElement!.cloneNode(false) as HTMLElement;
      wrapper.removeAttribute('id');
      wrapper.removeAttribute('role');
      wrapper.removeAttribute('aria-label');
      wrapper.setAttribute('aria-hidden', 'true');
      wrapper.inert = true;
      Object.assign(wrapper.style, {
        position: 'fixed',
        visibility: 'hidden',
        pointerEvents: 'none',
        display: 'block',
        width: 'max-content',
        top: '0',
        left: '0',
      });
      const copy = source.cloneNode(true) as HTMLElement;
      copy.style.width = 'max-content';
      copy.style.maxWidth = 'none';
      copy.querySelector('.col-resize-handle')?.remove();
      wrapper.append(copy);
      source.parentElement!.parentElement!.append(wrapper);
      return { wrapper, copy };
    });
    try {
      for (const { copy } of probes) {
        width = Math.max(width, Math.ceil(copy.getBoundingClientRect().width / scale));
      }
    } finally {
      for (const { wrapper } of probes) wrapper.remove();
    }
    onColumnWidthsChange({ ...widthsForManualResize(), [key]: width });
  };

  const headerCell = (key: ResizableColumnKey, label: ReactNode, className: string) => {
    const dragHandleProps = getDragHandleProps(key);
    return (
      <HeaderCell
        key={key}
        columnKey={key}
        label={label}
        active={sort.key === key}
        descending={sort.dir === 'desc'}
        onSort={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setSort((previous) => ({
            key: previous.key === key && previous.dir === 'desc' ? 'queue' : key,
            dir: previous.key === key && previous.dir === 'asc' ? 'desc' : 'asc',
          }));
          if (listRef.current) listRef.current.scrollTop = 0;
        }}
        className={className}
        reorderable={!!onColumnOrderChange}
        dragging={draggedColumn === key}
        registerRef={registerHeaderRef(key)}
        onDragMouseDown={dragHandleProps.onMouseDown}
        onResizeStart={onColumnWidthsChange ? startColumnResize(key) : undefined}
        onResizeFit={onColumnWidthsChange ? fitColumnWidth(key) : undefined}
      />
    );
  };
  const handleListScroll = (e: UIEvent<HTMLDivElement>) => {
    if (colHeaderRef.current) colHeaderRef.current.scrollLeft = e.currentTarget.scrollLeft;
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
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setColumnMenu({ x: event.clientX, y: event.clientY });
          }}
          ref={colHeaderRef}
          style={{ gridTemplateColumns }}
        >
          <div className="col-direction" aria-hidden="true" />
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
              connectionLabel={connectionLabel}
              columnOrder={visibleReorderableKeys}
              gridTemplateColumns={gridTemplateColumns}
              speedSamples={speedSamples}
              measuredSpeed={speeds.get(item.id) ?? null}
              onRetry={onRetry}
              onPause={onPause}
              onStop={onStop}
            />
          ))}
      </div>
      {columnMenu &&
        createPortal(
          <ContextMenu
            {...columnMenu}
            onClose={() => setColumnMenu(null)}
            items={[
              ...columnOrderFull.map((key) => ({
                label: t(COLUMN_LABEL_KEY[key]),
                checked: !hidden.includes(key),
                disabled:
                  visibleReorderableKeys.length === 1 && visibleReorderableKeys.includes(key),
                onClick: () => {
                  const next = hidden.includes(key)
                    ? hidden.filter((column) => column !== key)
                    : [...hidden, key];
                  setLocalHidden(next);
                  onHiddenColumnsChange?.(next);
                },
              })),
              { separator: true },
              { label: t('filePane.resetColumnWidths'), onClick: () => onColumnWidthsChange?.({}) },
            ]}
          />,
          document.body,
        )}
    </div>
  );
}
