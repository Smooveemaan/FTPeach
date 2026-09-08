import type { MouseEvent as ReactMouseEvent } from 'react';
import { useRef } from 'react';
import { getInterfaceScale } from '../platform/interfaceScale.ts';

interface ResizeState {
  startX: number;
  startWidth: number;
  minWidth: number;
  direction: 1 | -1;
  onResize: (nextWidth: number) => void;
}

export interface StartColumnResizeOptions {
  startWidth: number;
  minWidth: number;
  onResize: (nextWidth: number) => void;
  onResizeEnd?: () => void;
  /** Defaults to reading the handle's own computed `direction` (RTL-aware). */
  direction?: 1 | -1;
}

/**
 * Drives a single column-resize drag from a `.col-resize-handle`'s
 * `onMouseDown`. Shared by the file browser and the transfer queue so both
 * tables resize at identical, interface-scale-aware rates.
 */

export interface ColumnResizeModel {
  startColumnResize: (
    options: StartColumnResizeOptions,
  ) => (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useColumnResize(): ColumnResizeModel {
  const resizeState = useRef<ResizeState | null>(null);

  const startColumnResize =
    (options: StartColumnResizeOptions) => (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const scale = getInterfaceScale();
      const direction =
        options.direction ?? (getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1);
      resizeState.current = {
        startX: event.clientX,
        startWidth: options.startWidth,
        minWidth: options.minWidth,
        direction,
        onResize: options.onResize,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('column-resize-active');

      const finish = () => {
        resizeState.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove('column-resize-active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onUp);
        options.onResizeEnd?.();
      };
      const onMove = (moveEvent: MouseEvent) => {
        const state = resizeState.current;
        if (!state) return;
        if (moveEvent.buttons === 0) {
          // The button was released without a mouseup reaching us (e.g. the
          // OS swallowed it while focus moved to another webview) — don't
          // leave the drag latched on.
          finish();
          return;
        }
        const delta = ((moveEvent.clientX - state.startX) / scale) * state.direction;
        state.onResize(Math.max(state.minWidth, state.startWidth + delta));
      };
      const onUp = finish;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onUp);
    };

  return { startColumnResize };
}
