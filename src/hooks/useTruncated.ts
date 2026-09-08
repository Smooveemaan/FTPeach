import type { MutableRefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Tracks whether an element's content actually overflows its box, so a
 * fade-out mask (see the `.truncated` CSS variants) only ever appears when
 * text is really being cut off, not on every fixed-width label.
 */
export function useTruncated<T extends HTMLElement = HTMLDivElement>(
  deps: readonly unknown[] = [],
): readonly [MutableRefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
    // Re-checks on every caller-supplied dep in addition to the ResizeObserver,
    // which only fires on the element's own box size — not on content swaps
    // (e.g. a recycled virtualized row) that leave the box size unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [ref, truncated] as const;
}
