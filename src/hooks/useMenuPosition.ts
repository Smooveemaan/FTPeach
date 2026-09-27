import type { RefObject } from 'react';
import { useLayoutEffect, useState } from 'react';
import { getInterfaceScale } from '../platform/interfaceScale.ts';

export interface MenuPosition {
  top: number;
  left: number;
}

/** Offsets of an overlay in the scaled root; `inlineStart` counts from the right edge in RTL. */
export interface OverlayPlacement {
  top: number;
  inlineStart: number;
}

export interface OverlayViewport {
  width: number;
  height: number;
  scale: number;
  rtl: boolean;
}

export interface OverlayBox {
  /** Known size keeps the overlay inside the viewport on that axis; unknown keeps its start edge in. */
  width?: number | undefined;
  height?: number | undefined;
  /** Space between the anchor's bottom and the overlay, in screen pixels. */
  gap: number;
  /** Least distance from any viewport edge the overlay is clamped to. */
  margin: number;
}

type AnchorRect = Pick<DOMRect, 'left' | 'right' | 'bottom'>;

export function readOverlayViewport(): OverlayViewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scale: getInterfaceScale(),
    rtl: document.documentElement.dir === 'rtl',
  };
}

/**
 * Where an overlay opened below its anchor goes. The anchor rectangle and the window size are
 * screen pixels; the result is in the root's pixels, which the interface scale divides.
 */
export function placeBelowAnchor(
  anchor: AnchorRect,
  viewport: OverlayViewport,
  { width, height, gap, margin }: OverlayBox,
): OverlayPlacement {
  const viewportWidth = viewport.width / viewport.scale;
  const viewportHeight = viewport.height / viewport.scale;
  const start = viewport.rtl
    ? viewportWidth - anchor.right / viewport.scale
    : anchor.left / viewport.scale;
  const below = (anchor.bottom + gap) / viewport.scale;
  return {
    top: Math.max(
      margin,
      height === undefined ? below : Math.min(below, viewportHeight - height - margin),
    ),
    inlineStart: Math.max(
      margin,
      width === undefined ? start : Math.min(start, viewportWidth - width - margin),
    ),
  };
}

/**
 * Places an open overlay below its trigger. It is placed once to render, then
 * measured and placed again, so its real width and height keep it inside the
 * window: an estimate falls short once the interface is scaled up or the
 * labels are long.
 */
export function useAnchoredOverlay(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
): OverlayPlacement | null {
  const [placement, setPlacement] = useState<OverlayPlacement | null>(null);
  const placed = placement !== null;
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const update = () => {
      if (!trigger.current) return;
      const viewport = readOverlayViewport();
      const size = panel.current?.getBoundingClientRect();
      setPlacement(
        placeBelowAnchor(trigger.current.getBoundingClientRect(), viewport, {
          width: size && size.width / viewport.scale,
          height: size && size.height / viewport.scale,
          gap: 2,
          margin: 8,
        }),
      );
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, placed, trigger, panel]);
  return open ? placement : null;
}

interface MenuGrid {
  count: number;
  columns: number;
  cell: number;
  gap: number;
  padding: number;
  maxRows: number;
  scrollbarWidth: number;
}

export function useMenuPosition(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  { count, columns, cell, gap, padding, maxRows, scrollbarWidth }: MenuGrid,
): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!anchor.current) return;
      const rows = Math.min(maxRows, Math.ceil(count / columns));
      const width =
        columns * cell +
        (columns - 1) * gap +
        padding * 2 +
        (count > columns * maxRows ? scrollbarWidth : 0);
      const height = rows * cell + (rows - 1) * gap + padding * 2;
      const viewport = readOverlayViewport();
      const { top, inlineStart } = placeBelowAnchor(
        anchor.current.getBoundingClientRect(),
        viewport,
        { width, height, gap: 2, margin: 8 },
      );
      setPosition({
        top,
        left: viewport.rtl ? viewport.width / viewport.scale - inlineStart - width : inlineStart,
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor, open, count, columns, cell, gap, padding, maxRows, scrollbarWidth]);
  return open ? position : null;
}
