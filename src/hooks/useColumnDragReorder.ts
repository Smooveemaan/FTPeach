import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';

const DRAG_THRESHOLD_PX = 4;
// A small dead zone straddling each column's midpoint: the pointer must
// overshoot the midpoint by this much before a swap fires, in either
// direction. Without it, hovering right at a boundary between two
// unequally-sized columns can flip the order back and forth on tiny,
// unintentional pointer jitter.
const SWAP_HYSTERESIS_PX = 8;
const FLIP_DURATION_MS = 150;

interface DragState {
  key: string;
  startX: number;
  active: boolean;
  originalOrder: string[];
}

/** Unanimated grid slot for both hit-testing and FLIP. */
interface HeaderRect {
  left: number;
  width: number;
}

export interface UseColumnDragReorderOptions {
  /** Current order of the reorderable columns (pinned columns excluded). */
  order: readonly string[];
  /** Called with the full next order once a drag crosses into a new slot. */
  onReorder?: ((next: string[]) => void) | undefined;
}

export interface UseColumnDragReorderResult {
  /** The key of the column currently being dragged, if any. */
  draggedColumn: string | null;
  /** Ref-callback factory: attach to each reorderable header for FLIP + hit-testing. */
  registerHeaderRef: (key: string) => (element: HTMLElement | null) => void;
  /** Spread onto a reorderable header to arm a drag on primary mousedown. */
  getDragHandleProps: (key: string) => {
    'data-column-key': string;
    'data-dragging': 'true' | undefined;
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  /** True once a completed drag should swallow the header's own click (sort toggle, etc). */
  suppressClickRef: MutableRefObject<boolean>;
  /** Re-measure header positions without animating — call after a resize or
   * any other layout change that isn't itself a reorder, so the next real
   * reorder's FLIP diff is computed from a clean baseline. */
  refreshRects: () => void;
  /** The registered header elements, keyed by column key — for callers that
   * need to read a header's own DOM (e.g. to measure its label). */
  headerElements: MutableRefObject<Map<string, HTMLElement>>;
}

/**
 * Left edge of every reorderable header, computed from the grid container's
 * own (always-consistent) `grid-template-columns` and gap rather than from
 * each item's own `getBoundingClientRect()`.
 *
 * Under very fast, repeated reorders, Chromium's grid layout can report a
 * stale `left` for the item that just landed in the *first* reorderable
 * slot via `getBoundingClientRect()` — width comes back correct, only the
 * position lags — even though the DOM order and the container's own
 * `grid-template-columns` are already fully in sync with the new order.
 * Trusting that stale read for the FLIP `dx` is exactly what made a column
 * fling far outside the header on rapid swaps: the animation was sliding
 * from a phantom position. The container-level box model doesn't share
 * that lag, so deriving each column's left edge arithmetically from it
 * sidesteps the bug entirely instead of trying to out-wait it.
 */
function measureOrderRects(
  order: readonly string[],
  headerRefs: Map<string, HTMLElement>,
): Map<string, HeaderRect> {
  const rects = new Map<string, HeaderRect>();
  const visibleOrder = order.filter((key) => headerRefs.has(key));
  const firstKey = visibleOrder[0];
  const firstEl = firstKey === undefined ? undefined : headerRefs.get(firstKey);
  const container = firstEl?.parentElement;
  if (!firstEl || !container) return rects;

  const domChildren = [...container.children] as HTMLElement[];
  const firstIdx = domChildren.indexOf(firstEl);
  if (firstIdx === -1) return rects;

  const containerRect = container.getBoundingClientRect();
  const cs = getComputedStyle(container);
  const rtl = cs.direction === 'rtl';
  const gapPx = parseFloat(cs.columnGap) || 0;
  const paddingStart = parseFloat(rtl ? cs.paddingInlineEnd : cs.paddingInlineStart) || 0;
  const trackWidths = cs.gridTemplateColumns
    .trim()
    .split(/\s+/)
    .map((v) => parseFloat(v) || 0);

  let leadingSpan = 0;
  for (let i = 0; i < firstIdx; i++) leadingSpan += (trackWidths[i] ?? 0) + gapPx;

  if (!rtl) {
    let cursor = containerRect.left + paddingStart + leadingSpan;
    visibleOrder.forEach((key, i) => {
      const width = trackWidths[firstIdx + i] ?? 0;
      rects.set(key, { left: cursor, width });
      cursor += width + gapPx;
    });
  } else {
    let cursor = containerRect.right - paddingStart - leadingSpan;
    visibleOrder.forEach((key, i) => {
      const width = trackWidths[firstIdx + i] ?? 0;
      rects.set(key, { left: cursor - width, width });
      cursor -= width + gapPx;
    });
  }
  return rects;
}

/**
 * Live column reordering: press-drag-threshold, midpoint+hysteresis swap
 * detection, a post-drop FLIP slide, and a matching set of escape hatches
 * (Escape restores the pre-drag order; losing window focus or the mouse
 * button just ends the drag in place) so a drag can never get stuck.
 *
 * Shared by the file browser's column headers and the transfer queue's.
 */
export function useColumnDragReorder({
  order,
  onReorder,
}: UseColumnDragReorderOptions): UseColumnDragReorderResult {
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const headerRefs = useRef(new Map<string, HTMLElement>());
  const rectsRef = useRef(new Map<string, HeaderRect>());
  const flipAnimRef = useRef(
    new Map<string, { raf: number; timeout: number; elements: HTMLElement[] }>(),
  );

  const orderRef = useRef(order);
  orderRef.current = order;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const registerHeaderRef = (key: string) => (element: HTMLElement | null) => {
    if (element) headerRefs.current.set(key, element);
    else headerRefs.current.delete(key);
  };

  useEffect(
    () => () => {
      flipAnimRef.current.forEach(({ raf, timeout, elements }) => {
        cancelAnimationFrame(raf);
        clearTimeout(timeout);
        elements.forEach((el) => {
          el.style.transition = '';
          el.style.transform = '';
        });
      });
      flipAnimRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const endDrag = (restoreOriginal: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (drag.active) {
        document.body.style.cursor = '';
        document.body.classList.remove('column-reorder-active');
        suppressClickRef.current = true;
        setDraggedColumn(null);
        if (restoreOriginal) onReorderRef.current?.(drag.originalOrder);
      }
    };

    let pendingEvent: MouseEvent | null = null;
    let rafId: number | null = null;

    const evaluate = () => {
      rafId = null;
      const e = pendingEvent;
      pendingEvent = null;
      const drag = dragRef.current;
      if (!e || !drag) return;
      if (e.buttons === 0) {
        // The button let go without a mouseup reaching us.
        endDrag(false);
        return;
      }
      if (!drag.active) {
        if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        document.body.style.cursor = 'grabbing';
        document.body.classList.add('column-reorder-active');
        setDraggedColumn(drag.key);
      }
      const reorder = onReorderRef.current;
      if (!reorder) return;
      const cols = orderRef.current;
      const fromIdx = cols.indexOf(drag.key);
      if (fromIdx === -1) return;
      // Animated element bounds drift and overlap during FLIP. Only use the
      // grid's resting slots, and allow crossing multiple slots or either end.
      const rects = measureOrderRects(cols, headerRefs.current);
      const container = headerRefs.current.get(drag.key)?.parentElement;
      const rtl = container ? getComputedStyle(container).direction === 'rtl' : false;
      let toIdx = fromIdx;
      cols.forEach((key, index) => {
        const rect = rects.get(key);
        if (index === fromIdx || !rect || rect.width <= 0) return;
        const midpoint = rect.left + rect.width / 2;
        const hysteresis = Math.min(SWAP_HYSTERESIS_PX, rect.width / 4);
        const movingRight = index > fromIdx !== rtl;
        const crossed = movingRight
          ? e.clientX > midpoint + hysteresis
          : e.clientX < midpoint - hysteresis;
        if (crossed && Math.abs(index - fromIdx) > Math.abs(toIdx - fromIdx)) toIdx = index;
      });
      if (toIdx === fromIdx) return;

      const next = [...cols];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, drag.key);
      reorder(next);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      pendingEvent = e;
      if (rafId == null) rafId = requestAnimationFrame(evaluate);
    };
    const handleMouseUp = () => endDrag(false);
    const handleBlur = () => endDrag(false);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current?.active) endDrag(true);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      endDrag(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // FLIP: whenever the order changes, slide each header from its previous
  // screen position to its new one instead of letting the reflow snap.
  const orderKey = order.join(',');
  useLayoutEffect(() => {
    // A reorder that lands mid-flight of a still-animating previous one must
    // not measure through the old transform: a leftover transform would
    // offset the measurement from the element's true grid slot, so `dx`
    // would come out wrong — compounding with every rapid swap. Snapping
    // every in-flight animation to its resting state first (no transition)
    // guarantees every measurement below reflects the real layout.
    flipAnimRef.current.forEach(({ raf, timeout, elements }) => {
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
      elements.forEach((el) => {
        el.style.transition = '';
        el.style.transform = '';
      });
    });
    flipAnimRef.current.clear();

    const prevRects = rectsRef.current;
    const nextRects = measureOrderRects(order, headerRefs.current);
    const scope = [...headerRefs.current.values()][0]?.closest('[data-column-reorder-scope]');
    const cellsByKey = new Map<string, HTMLElement[]>();
    scope?.querySelectorAll<HTMLElement>('[data-column-cell]').forEach((cell) => {
      const key = cell.dataset.columnCell!;
      const cells = cellsByKey.get(key) ?? [];
      cells.push(cell);
      cellsByKey.set(key, cells);
    });
    nextRects.forEach((next, key) => {
      const prev = prevRects.get(key);
      const el = headerRefs.current.get(key);
      if (!prev || !el) return;
      const dx = prev.left - next.left;
      if (Math.abs(dx) < 1) return;
      // All mounted data cells share their header's displacement and timing.
      // Virtualized rows outside the DOM require no work or measurements.
      const elements = [el, ...(cellsByKey.get(key) ?? [])];
      elements.forEach((element) => {
        element.style.transition = 'none';
        element.style.transform = `translateX(${dx}px)`;
      });
      el.getBoundingClientRect(); // force layout so the line above lands before the next one
      const raf = requestAnimationFrame(() => {
        elements.forEach((element) => {
          element.style.transition = `transform ${FLIP_DURATION_MS}ms ease`;
          element.style.transform = '';
        });
        const timeout = window.setTimeout(() => {
          elements.forEach((element) => {
            element.style.transition = '';
          });
          flipAnimRef.current.delete(key);
        }, FLIP_DURATION_MS);
        flipAnimRef.current.set(key, { raf: 0, timeout, elements });
      });
      flipAnimRef.current.set(key, { raf, timeout: 0, elements });
    });
    rectsRef.current = nextRects;
    // `orderKey` is `order.join(',')` — the same information, but stable across
    // renders that rebuild the array without changing it. Depending on `order`
    // itself would restart this FLIP animation mid-flight on every such render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  const refreshRects = () => {
    rectsRef.current = measureOrderRects(order, headerRefs.current);
  };

  const getDragHandleProps = (key: string) => ({
    'data-column-key': key,
    'data-dragging': draggedColumn === key ? ('true' as const) : undefined,
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0 || !onReorderRef.current) return;
      suppressClickRef.current = false;
      dragRef.current = { key, startX: event.clientX, active: false, originalOrder: [...order] };
    },
  });

  return {
    draggedColumn,
    registerHeaderRef,
    getDragHandleProps,
    suppressClickRef,
    refreshRects,
    headerElements: headerRefs,
  };
}
