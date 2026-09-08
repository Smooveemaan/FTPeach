import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

export const ITEM_WIDTH = 26 + 6; // .btn-icon + one row gap
export const DIVIDER_WIDTH = 6 + 2 + 1 + 2; // row gap + .toolbar-divider's own margin/width/margin

const EMPTY_SET = new Set<string>();

interface FoldItem {
  key: string;
  width: number;
}

interface OverflowFoldOptions {
  containerRef: RefObject<HTMLElement>;
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
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  const natural = baseWidth + foldOrder.reduce((sum, item) => sum + item.width, 0) - 6;

  if (width === 0 || natural <= width) {
    return { foldedKeys: EMPTY_SET, hasOverflow: false };
  }

  const budget = width - ITEM_WIDTH;
  let remaining = natural;
  let count = 0;
  for (const item of foldOrder) {
    if (remaining <= budget) break;
    remaining -= item.width;
    count += 1;
  }
  return {
    foldedKeys: new Set(foldOrder.slice(0, count).map((item) => item.key)),
    hasOverflow: count > 0,
  };
}
