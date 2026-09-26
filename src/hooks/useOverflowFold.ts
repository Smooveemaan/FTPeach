import type { RefObject } from 'react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

export const ITEM_WIDTH = 26 + 6; // .btn-icon + one row gap
export const DIVIDER_WIDTH = 6 + 2 + 1 + 2; // row gap + .toolbar-divider's own margin/width/margin

const EMPTY_SET = new Set<string>();

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

  // Button widths and order can change without resizing the container.
  // Keep the observer subscribed while using the latest committed options.
  useEffect(() => {
    updateFold(widthRef.current);
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
