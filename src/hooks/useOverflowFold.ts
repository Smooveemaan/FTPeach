import type { RefObject } from 'react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

export const ITEM_WIDTH = 26 + 6; // .btn-icon + one row gap
export const DIVIDER_WIDTH = 6 + 2 + 1 + 2; // row gap + .toolbar-divider's own margin/width/margin

const EMPTY_SET = new Set<string>();

function contentWidth(el: HTMLElement): number {
  const rectWidth = el.getBoundingClientRect().width;
  if (rectWidth <= 0) return 0;
  const style = getComputedStyle(el);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const border =
    (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
  return Math.max(0, rectWidth - padding - border);
}

interface FoldItem {
  key: string;
  width: number;
}

interface OverflowFoldOptions {
  containerRef: RefObject<HTMLElement | null>;
  baseWidth: number;
  foldOrder: readonly FoldItem[];
}

export interface OverflowFoldModel {
  foldedKeys: Set<string>;
  hasOverflow: boolean;
}

export function useOverflowFold({
  containerRef,
  baseWidth,
  foldOrder,
}: OverflowFoldOptions): OverflowFoldModel {
  const widthRef = useRef(0);
  const [count, setCount] = useState(0);

  const updateFold = useEffectEvent((width: number) => {
    widthRef.current = width;
    const natural = baseWidth + foldOrder.reduce((sum, item) => sum + item.width, 0) - 6;
    let nextCount = 0;
    if (width > 0 && natural > width) {
      const budget = width - ITEM_WIDTH;
      let remaining = natural;
      for (const item of foldOrder) {
        if (remaining <= budget) break;
        remaining -= item.width;
        nextCount += 1;
      }
    }
    if (nextCount !== count) setCount(nextCount);
  });

  // Measure synchronously before the first paint so freshly mounted toolbars
  // (e.g. when creating or switching tabs) fold overflowed buttons without
  // flashing them, and recalculate when button geometry changes without a resize.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const measured = el ? contentWidth(el) : 0;
    updateFold(measured > 0 ? measured : widthRef.current);
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateFold(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  return {
    foldedKeys: count > 0 ? new Set(foldOrder.slice(0, count).map((item) => item.key)) : EMPTY_SET,
    hasOverflow: count > 0,
  };
}
