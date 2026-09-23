import type {
  MutableRefObject,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { getInterfaceScale } from '../../../platform/interfaceScale.ts';
import type { FileEntry } from '../../../shared/types.ts';
import type { PaneId } from '../panes/paneModel.ts';
import { DRAG_THRESHOLD_PX } from './fileListModel.ts';
import type { VirtualListHandle } from './useVirtualizedFileList.ts';

const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_MAX_SPEED = 16;

interface FileSelectionOptions {
  entries: readonly FileEntry[];
  sorted: readonly FileEntry[];
  selectedNames: ReadonlySet<string>;
  onSelectionChange: (selectedNames: Set<string>) => void;
  isVirtualized: boolean;
  listRef: MutableRefObject<VirtualListHandle | null>;
  side: PaneId;
}

export interface FileSelectionModel {
  activeIndexRef: MutableRefObject<number | null>;
  marqueeElRef: MutableRefObject<HTMLDivElement | null>;
  handleRowClick: (index: number, e: ReactMouseEvent<HTMLElement>) => void;
  selectForContextMenu: (index: number) => void;
  startMarquee: (e: ReactPointerEvent<HTMLDivElement>) => void;
  moveActive: (delta: number, extend: boolean) => void;
  jumpActive: (index: number, extend: boolean) => void;
  toggleActive: () => void;
  handleTypeahead: (char: string) => void;
  clear: () => void;
}

export default function useFileSelection({
  entries,
  sorted,
  selectedNames,
  onSelectionChange,
  isVirtualized,
  listRef,
  side,
}: FileSelectionOptions): FileSelectionModel {
  // The range anchor and the active row are kept by name: an index would
  // point at a different file once the list is sorted or filtered again.
  const anchorNameRef = useRef<string | null>(null);
  const activeNameRef = useRef<string | null>(null);
  const activeIndexRef = useRef<number | null>(null);
  const marqueeElRef = useRef<HTMLDivElement | null>(null);
  const endMarqueeRef = useRef<(() => void) | null>(null);
  const typeaheadRef = useRef({ buffer: '', lastTime: 0 });
  const stateRef = useRef({ sorted, selectedNames, onSelectionChange });
  stateRef.current = { sorted, selectedNames, onSelectionChange };

  const setActive = (index: number | null) => {
    activeIndexRef.current = index;
    activeNameRef.current = index == null ? null : (stateRef.current.sorted[index]?.name ?? null);
  };

  useEffect(() => {
    anchorNameRef.current = null;
    setActive(null);
    typeaheadRef.current = { buffer: '', lastTime: 0 };
  }, [entries]);

  useEffect(() => {
    const name = activeNameRef.current;
    const index = name == null ? -1 : sorted.findIndex((entry) => entry.name === name);
    activeIndexRef.current = index < 0 ? null : index;
    if (index < 0) activeNameRef.current = null;
  }, [sorted]);

  // A pane that goes away mid-drag (its tab closed) stops the marquee too.
  useEffect(() => () => endMarqueeRef.current?.(), []);

  const selectSingle = (index: number) => {
    const { sorted, onSelectionChange } = stateRef.current;
    const entry = sorted[index];
    if (!entry) return;
    anchorNameRef.current = entry.name;
    activeIndexRef.current = index;
    activeNameRef.current = entry.name;
    onSelectionChange(new Set([entry.name]));
  };

  const selectRangeTo = (index: number) => {
    const { sorted, onSelectionChange } = stateRef.current;
    const anchorName = anchorNameRef.current;
    let anchorIndex = anchorName == null ? -1 : sorted.findIndex((e) => e.name === anchorName);
    if (anchorIndex < 0) {
      anchorIndex = index;
      anchorNameRef.current = sorted[index]?.name ?? null;
    }
    activeIndexRef.current = index;
    activeNameRef.current = sorted[index]?.name ?? null;
    const [start, end] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
    onSelectionChange(new Set(sorted.slice(start, end + 1).map((e) => e.name)));
  };

  const toggleAt = (index: number) => {
    const { sorted, selectedNames, onSelectionChange } = stateRef.current;
    const entry = sorted[index];
    if (!entry) return;
    anchorNameRef.current = entry.name;
    activeIndexRef.current = index;
    activeNameRef.current = entry.name;
    const name = entry.name;
    const next = new Set(selectedNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onSelectionChange(next);
  };

  const handleRowClick = useCallback((index: number, e: ReactMouseEvent<HTMLElement>) => {
    if (e.shiftKey) selectRangeTo(index);
    else if (e.ctrlKey || e.metaKey) toggleAt(index);
    else selectSingle(index);
  }, []);

  const selectForContextMenu = useCallback((index: number) => {
    const { sorted, selectedNames } = stateRef.current;
    const name = sorted[index]?.name;
    if (name != null && !selectedNames.has(name)) selectSingle(index);
  }, []);

  const startMarquee = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (
      e.target instanceof Element &&
      e.target.closest('.row, input, button, textarea, .col-resize-handle, .pane-empty')
    )
      return;
    if (e.target === e.currentTarget) {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const verticalGutter = Math.max(0, el.offsetWidth - el.clientWidth);
      const horizontalGutter = Math.max(0, el.offsetHeight - el.clientHeight);
      const rtl = getComputedStyle(el).direction === 'rtl';
      const onVerticalScrollbar =
        verticalGutter > 0 &&
        (rtl ? e.clientX < rect.left + verticalGutter : e.clientX >= rect.right - verticalGutter);
      const onHorizontalScrollbar =
        horizontalGutter > 0 && e.clientY >= rect.bottom - horizontalGutter;
      if (onVerticalScrollbar || onHorizontalScrollbar) return;
    }
    const captureEl = e.currentTarget;
    const pointerId = e.pointerId;
    captureEl.setPointerCapture(pointerId);

    const additive = e.ctrlKey || e.metaKey;
    const marqueeEl = marqueeElRef.current;
    const listEl = document.querySelector<HTMLElement>(`.pane-list[data-side="${side}"]`);
    const state = {
      startX: e.clientX,
      startY: e.clientY,
      startScrollTop: listEl ? listEl.scrollTop : 0,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
    };
    // What Ctrl+drag adds to. It never changes during the drag, so shrinking
    // the rectangle gives back exactly what was selected before.
    const initial: ReadonlySet<string> = additive ? new Set(selectedNames) : new Set();
    let autoScrollSpeed = 0;
    let autoScrollRaf: number | null = null;

    const anchorY = () =>
      listEl ? state.startY - (listEl.scrollTop - state.startScrollTop) : state.startY;

    // Rows are hit by position in the list model, not by what is mounted: a
    // virtualized list only renders the rows on screen, and a row scrolled
    // out of the DOM is still inside the rectangle. Every row has the same
    // height, so one mounted row gives the position of all of them.
    const rowsIn = (top: number, bottom: number, left: number, right: number): string[] => {
      const { sorted } = stateRef.current;
      const probe = listEl?.querySelector<HTMLElement>('.row[data-index]');
      if (!probe) return [];
      const box = probe.getBoundingClientRect();
      if (box.height <= 0 || box.left >= right || box.right <= left) return [];
      const origin = box.top - Number(probe.dataset.index) * box.height;
      const first = Math.max(0, Math.floor((top - origin) / box.height));
      const last = Math.min(sorted.length - 1, Math.ceil((bottom - origin) / box.height) - 1);
      return sorted.slice(first, last + 1).map((entry) => entry.name);
    };

    const applySelection = (x2: number, y2: number) => {
      const startY = anchorY();
      const hit = rowsIn(
        Math.min(startY, y2),
        Math.max(startY, y2),
        Math.min(state.startX, x2),
        Math.max(state.startX, x2),
      );
      stateRef.current.onSelectionChange(new Set([...initial, ...hit]));
    };

    const updateMarqueeVisual = (x2: number, y2: number) => {
      if (!marqueeEl) return;
      const startY = anchorY();
      let left = Math.min(state.startX, x2);
      let right = Math.max(state.startX, x2);
      let top = Math.min(startY, y2);
      let bottom = Math.max(startY, y2);
      if (listEl) {
        const clip = listEl.getBoundingClientRect();
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      const scale = getInterfaceScale();
      marqueeEl.style.left = `${left / scale}px`;
      marqueeEl.style.top = `${top / scale}px`;
      marqueeEl.style.width = `${Math.max(0, right - left) / scale}px`;
      marqueeEl.style.height = `${Math.max(0, bottom - top) / scale}px`;
    };

    const speedFor = (dist: number) => {
      if (dist >= AUTO_SCROLL_EDGE) return 0;
      return AUTO_SCROLL_MAX_SPEED * Math.min(1, (AUTO_SCROLL_EDGE - dist) / AUTO_SCROLL_EDGE);
    };

    const scrollTick = () => {
      if (listEl && autoScrollSpeed) {
        listEl.scrollTop += autoScrollSpeed;
        applySelection(state.lastX, state.lastY);
        updateMarqueeVisual(state.lastX, state.lastY);
      }
      autoScrollRaf = requestAnimationFrame(scrollTick);
    };

    const updateAutoScroll = (clientY: number) => {
      if (!listEl) {
        autoScrollSpeed = 0;
        return;
      }
      const rect = listEl.getBoundingClientRect();
      const up = speedFor(clientY - rect.top);
      autoScrollSpeed = up ? -up : speedFor(rect.bottom - clientY);
    };

    const onMove = (moveEvent: PointerEvent) => {
      state.lastX = moveEvent.clientX;
      state.lastY = moveEvent.clientY;
      if (!state.active) {
        const dx = moveEvent.clientX - state.startX;
        const dy = moveEvent.clientY - state.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        state.active = true;
        if (marqueeEl) marqueeEl.style.display = 'block';
        autoScrollRaf = requestAnimationFrame(scrollTick);
      }
      updateMarqueeVisual(moveEvent.clientX, moveEvent.clientY);
      updateAutoScroll(moveEvent.clientY);
      applySelection(moveEvent.clientX, moveEvent.clientY);
    };

    // Every way a drag can end runs this once: release, cancel, a capture
    // the browser took away, or the pane unmounting.
    const stop = () => {
      captureEl.removeEventListener('pointermove', onMove);
      captureEl.removeEventListener('pointerup', onUp);
      captureEl.removeEventListener('pointercancel', stop);
      captureEl.removeEventListener('lostpointercapture', stop);
      if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId);
      if (autoScrollRaf != null) cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
      if (marqueeEl) marqueeEl.style.display = 'none';
      if (endMarqueeRef.current === stop) endMarqueeRef.current = null;
    };

    const onUp = () => {
      stop();
      if (state.active) {
        anchorNameRef.current = null;
        setActive(null);
      } else if (!additive) {
        // A plain click on empty space, no drag — Explorer clears the
        // selection rather than leaving it untouched.
        stateRef.current.onSelectionChange(new Set());
      }
    };

    endMarqueeRef.current?.();
    endMarqueeRef.current = stop;
    captureEl.addEventListener('pointermove', onMove);
    captureEl.addEventListener('pointerup', onUp);
    captureEl.addEventListener('pointercancel', stop);
    captureEl.addEventListener('lostpointercapture', stop);
  };

  const scrollRowIntoView = (index: number) => {
    const entry = sorted[index];
    if (!entry) return;
    if (isVirtualized) {
      listRef.current?.scrollToItem(index, 'smart');
      return;
    }
    const listEl = document.querySelector<HTMLElement>(`.pane-list[data-side="${side}"]`);
    const rowEl = listEl?.querySelector<HTMLElement>(`.row[data-name="${CSS.escape(entry.name)}"]`);
    rowEl?.scrollIntoView({ block: 'nearest' });
  };

  const moveActive = (delta: number, extend: boolean) => {
    if (sorted.length === 0) return;
    const base = activeIndexRef.current ?? (delta > 0 ? -1 : sorted.length);
    const next = Math.min(sorted.length - 1, Math.max(0, base + delta));
    if (extend) selectRangeTo(next);
    else selectSingle(next);
    scrollRowIntoView(next);
  };

  const jumpActive = (index: number, extend: boolean) => {
    if (sorted.length === 0) return;
    if (extend) selectRangeTo(index);
    else selectSingle(index);
    scrollRowIntoView(index);
  };

  const toggleActive = () => {
    if (sorted.length === 0) return;
    const index = activeIndexRef.current ?? 0;
    toggleAt(index);
    scrollRowIntoView(index);
  };

  const TYPEAHEAD_TIMEOUT_MS = 900;

  const handleTypeahead = (char: string) => {
    if (sorted.length === 0) return;
    const now = Date.now();
    const state = typeaheadRef.current;
    const continuing = now - state.lastTime <= TYPEAHEAD_TIMEOUT_MS;
    const priorBuffer = continuing ? state.buffer : '';
    const isSameLetterRepeat = priorBuffer.length > 0 && [...priorBuffer].every((c) => c === char);
    const query = isSameLetterRepeat ? char : priorBuffer + char;
    state.buffer = query;
    state.lastTime = now;

    const lower = query.toLowerCase();
    const n = sorted.length;
    const startAt = isSameLetterRepeat ? ((activeIndexRef.current ?? -1) + 1) % n : 0;
    for (let i = 0; i < n; i++) {
      const idx = (startAt + i) % n;
      if (sorted[idx]?.name.toLowerCase().startsWith(lower)) {
        jumpActive(idx, false);
        break;
      }
    }
  };

  return {
    activeIndexRef,
    marqueeElRef,
    handleRowClick,
    selectForContextMenu,
    startMarquee,
    moveActive,
    jumpActive,
    toggleActive,
    handleTypeahead,
    clear: () => {
      onSelectionChange(new Set());
      anchorNameRef.current = null;
      setActive(null);
    },
  };
}
