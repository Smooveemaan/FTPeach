import type { RefObject } from 'react';
import { useLayoutEffect, useState } from 'react';
import { getInterfaceScale } from '../platform/interfaceScale.ts';

export interface MenuPosition {
  top: number;
  left: number;
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
  anchor: RefObject<HTMLElement>,
  open: boolean,
  { count, columns, cell, gap, padding, maxRows, scrollbarWidth }: MenuGrid,
): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!anchor.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const rows = Math.min(maxRows, Math.ceil(count / columns));
      const width =
        columns * cell +
        (columns - 1) * gap +
        padding * 2 +
        (count > columns * maxRows ? scrollbarWidth : 0);
      const height = rows * cell + (rows - 1) * gap + padding * 2;
      const scale = getInterfaceScale();
      const preferredLeft =
        document.documentElement.dir === 'rtl' ? rect.right / scale - width : rect.left / scale;
      setPosition({
        top: Math.max(
          8,
          Math.min((rect.bottom + 2) / scale, window.innerHeight / scale - height - 8),
        ),
        left: Math.max(8, Math.min(preferredLeft, window.innerWidth / scale - width - 8)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor, open, count, columns, cell, gap, padding, maxRows, scrollbarWidth]);
  return open ? position : null;
}
