import type { MutableRefObject, MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { getInterfaceScale } from '../../../platform/interfaceScale.ts';
import type { DropAction, DropKeys } from './dropAction.ts';
import type { PaneId } from '../../../shared/types.ts';

export interface DragMovePayload {
  sourceSide: PaneId;
  names: string[];
  targetSide: PaneId;
  targetFolder: string | null;
  isMove: boolean;
}

export interface DragEntry {
  name: string;
  isDirectory: boolean;
}

interface ActiveDrag {
  side: PaneId;
  names: string[];
  entryName: string;
  isDir: boolean;
  startX: number;
  startY: number;
  active: boolean;
  isMove?: boolean;
  leftWindow?: boolean;
}

export interface DragInfo {
  count: number;
  name: string;
  isDir: boolean;
  isMove: boolean;
  isValidTarget: boolean;
  action: DropAction;
}

interface DropTarget {
  row: HTMLElement | null;
  side: PaneId | undefined;
  folder: string | null;
  list?: HTMLElement;
}

interface DragLeaveWindowPayload {
  side: PaneId;
  names: string[];
  entryName: string;
  isDir: boolean;
}

interface DragMoveOptions {
  resolveAction?: (
    sourceSide: PaneId,
    targetSide: PaneId,
    folder: string | null,
    names: string[],
    keys: DropKeys,
  ) => DropAction;
  onDragLeaveWindow?: (payload: DragLeaveWindowPayload) => void;
}

function closestElement(target: EventTarget | null, selector: string): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

const DRAG_THRESHOLD = 4;

const AUTO_SCROLL_EDGE = 48; // px from the list's own top/bottom edge
const AUTO_SCROLL_MAX_SPEED = 16; // px per animation frame, right at the edge

export interface DragMoveModel {
  startDrag: (side: PaneId, names: string[], entry: DragEntry, e: ReactMouseEvent) => void;
  cancelDrag: () => void | undefined;
  ghostRef: MutableRefObject<HTMLDivElement | null>;
  dragInfo: DragInfo | null;
}

export function useDragMove(
  onDrop: (payload: DragMovePayload) => void,
  { resolveAction, onDragLeaveWindow }: DragMoveOptions = {},
): DragMoveModel {
  const dragRef = useRef<ActiveDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);

  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const resolveActionRef = useRef(resolveAction);
  resolveActionRef.current = resolveAction;
  const onDragLeaveWindowRef = useRef(onDragLeaveWindow);
  onDragLeaveWindowRef.current = onDragLeaveWindow;
  const finishDragRef = useRef<((e: MouseEvent | undefined, commit: boolean) => void) | null>(null);

  // Which row (if any) currently shows the folder glow.
  const activeFolderRowRef = useRef<HTMLElement | null>(null);

  const autoScrollRef = useRef<{ el: HTMLElement | null; speed: number }>({ el: null, speed: 0 });
  const autoScrollRafRef = useRef<number | null>(null);

  useEffect(() => {
    const clearWash = () => {
      document
        .querySelectorAll('.pane-list.drag-wash, .pane-list.drag-wash-invalid')
        .forEach((p) => p.classList.remove('drag-wash', 'drag-wash-invalid'));
    };

    const scrollTick = () => {
      const { el, speed } = autoScrollRef.current;
      if (el && speed) el.scrollTop += speed;
      autoScrollRafRef.current = requestAnimationFrame(scrollTick);
    };

    const startAutoScroll = () => {
      if (autoScrollRafRef.current == null)
        autoScrollRafRef.current = requestAnimationFrame(scrollTick);
    };

    const stopAutoScroll = () => {
      if (autoScrollRafRef.current != null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
      autoScrollRef.current = { el: null, speed: 0 };
    };

    const updateAutoScroll = (e: MouseEvent) => {
      const listEl = closestElement(e.target, '.pane-list[data-side]');
      if (!listEl) {
        autoScrollRef.current = { el: null, speed: 0 };
        return;
      }
      const rect = listEl.getBoundingClientRect();
      const distTop = e.clientY - rect.top;
      const distBottom = rect.bottom - e.clientY;
      let speed = 0;
      if (distTop >= 0 && distTop < AUTO_SCROLL_EDGE) {
        speed = -AUTO_SCROLL_MAX_SPEED * (1 - distTop / AUTO_SCROLL_EDGE);
      } else if (distBottom >= 0 && distBottom < AUTO_SCROLL_EDGE) {
        speed = AUTO_SCROLL_MAX_SPEED * (1 - distBottom / AUTO_SCROLL_EDGE);
      }
      autoScrollRef.current = { el: listEl, speed };
    };

    const setGlowInstant = (rowEl: HTMLElement, on: boolean) => {
      rowEl.classList.add('drag-no-transition');
      rowEl.classList.toggle('drag-target', on);
      void rowEl.offsetWidth; // flush so the change above lands before transitions come back
      rowEl.classList.remove('drag-no-transition');
    };

    const setFolderTarget = (rowEl: HTMLElement | null) => {
      const prevRow = activeFolderRowRef.current;
      if (rowEl === prevRow) return;
      if (prevRow) setGlowInstant(prevRow, false);
      if (rowEl) setGlowInstant(rowEl, true);
      activeFolderRowRef.current = rowEl;
    };

    const nearestPaneList = (e: MouseEvent) => closestElement(e.target, '.pane-list[data-side]');

    const overNameCell = (e: MouseEvent, rowEl: HTMLElement) => {
      const width = parseFloat(getComputedStyle(rowEl).getPropertyValue('--name-cell-width')) || 0;
      const rect = rowEl.getBoundingClientRect();
      const rtl = getComputedStyle(rowEl).direction === 'rtl';
      const start = rtl ? rect.right - 12 - width : rect.left + 12;
      return e.clientX >= start && e.clientX <= start + width;
    };

    const resolveTarget = (e: MouseEvent): DropTarget | null => {
      const crumb = closestElement(e.target, '[data-drop-path]');
      if (crumb)
        return {
          row: crumb,
          side: crumb.closest<HTMLElement>('.pane[data-side]')?.dataset.side as PaneId | undefined,
          folder: crumb.dataset.dropPath ?? null,
        };
      const overRowEl = closestElement(e.target, '.row[data-name]');
      const overIsDir =
        !!overRowEl && overRowEl.classList.contains('is-dir') && overNameCell(e, overRowEl);
      const overListEl = overRowEl?.closest<HTMLElement>('.pane-list[data-side]') ?? null;
      const overSide = overListEl?.dataset.side as PaneId | undefined;
      if (overRowEl && overIsDir) {
        return { row: overRowEl, side: overSide, folder: overRowEl.dataset.name ?? null };
      }
      const list = nearestPaneList(e);
      return list
        ? { row: null, side: list.dataset.side as PaneId | undefined, folder: null, list }
        : null;
    };

    let lastPointer: MouseEvent | null = null;
    const actionFor = (drag: ActiveDrag, target: DropTarget | null, keys: DropKeys): DropAction => {
      if (!target?.side) return null;
      if (!target.row && target.side === drag.side) return null;
      if (resolveActionRef.current)
        return resolveActionRef.current(drag.side, target.side, target.folder, drag.names, keys);
      return keys.ctrlKey && keys.shiftKey ? 'invalid' : keys.shiftKey ? 'move' : 'copy';
    };
    const updateTarget = (e: MouseEvent, keys: DropKeys) => {
      const drag = dragRef.current;
      if (!drag?.active) return;
      const target = resolveTarget(e);
      const action = actionFor(drag, target, keys);
      clearWash();
      document.body.classList.toggle('drag-drop-forbidden', action === 'invalid');
      if (action === 'invalid' && target?.list?.closest('.pane[data-disconnected="true"]'))
        target.list.classList.add('drag-wash-invalid');
      setFolderTarget(action === 'copy' || action === 'move' ? (target?.row ?? null) : null);
      if (target?.list && action && action !== 'invalid') target.list.classList.add('drag-wash');
      setDragInfo((previous) =>
        previous?.action === action
          ? previous
          : {
              count: drag.names.length,
              name: drag.entryName,
              isDir: drag.isDir,
              isMove: action === 'move',
              isValidTarget: action !== 'invalid',
              action,
            },
      );
    };

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      lastPointer = e;

      if (!drag.active) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        document.body.classList.add('drag-move-active');
        startAutoScroll();
      }

      // Active by now either way: the block above starts the drag when the
      // threshold is crossed and returns when it is not.
      if (!drag.leftWindow) {
        const outOfBounds =
          e.clientX < 0 ||
          e.clientY < 0 ||
          e.clientX > window.innerWidth ||
          e.clientY > window.innerHeight;
        if (outOfBounds) {
          drag.leftWindow = true;
          onDragLeaveWindowRef.current?.({
            side: drag.side,
            names: drag.names,
            entryName: drag.entryName,
            isDir: drag.isDir,
          });
        }
      }

      if (ghostRef.current) {
        const scale = getInterfaceScale();
        const inlineOffset = document.documentElement.dir === 'rtl' ? -14 : 14;
        ghostRef.current.style.transform = `translate(${e.clientX / scale}px, ${e.clientY / scale}px) translate(${inlineOffset}px, -12px)`;
      }

      updateAutoScroll(e);
      updateTarget(e, e);
    };

    const handleModifierKey = (e: KeyboardEvent) => {
      if ((e.key === 'Control' || e.key === 'Shift') && lastPointer) updateTarget(lastPointer, e);
    };

    const finishDrag = (e: MouseEvent | undefined, commit: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      document.body.classList.remove('drag-move-active', 'drag-drop-forbidden');
      setDragInfo(null);
      stopAutoScroll();
      clearWash();
      if (activeFolderRowRef.current) {
        activeFolderRowRef.current.classList.remove('drag-target');
        activeFolderRowRef.current = null;
      }
      if (!drag.active) return;
      const suppressClick = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      document.addEventListener('click', suppressClick, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', suppressClick, true), 0);
      if (!commit || !e) return;

      const target = resolveTarget(e);
      if (!target || !target.side) return;
      const action = actionFor(drag, target, e);
      if (!action || action === 'invalid') return;
      onDropRef.current({
        sourceSide: drag.side,
        names: drag.names,
        targetSide: target.side,
        targetFolder: target.folder,
        isMove: action === 'move',
      });
    };

    finishDragRef.current = finishDrag;

    const handleMouseUp = (e: MouseEvent) => finishDrag(e, true);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) return finishDrag(undefined, false);
      handleModifierKey(e);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleModifierKey);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleModifierKey);
      stopAutoScroll();
    };
  }, []);

  // entry: { name, isDirectory }. Left button only — right-click still goes
  // to the context menu, untouched by any of this.
  const startDrag = (side: PaneId, names: string[], entry: DragEntry, e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = {
      side,
      names,
      entryName: entry.name,
      isDir: entry.isDirectory,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
  };

  // Tears down the in-app drag state (ghost, wash, auto-scroll, source) exactly as Escape does, without committing a drop. Callers hand
  // off to a native OS drag (see useFileClipboard's onDragLeaveWindow) call
  // this immediately so the later mouseup doesn't misinterpret leftover DOM
  // state as an in-app drop.
  const cancelDrag = () => finishDragRef.current?.(undefined, false);

  return { startDrag, cancelDrag, ghostRef, dragInfo };
}
