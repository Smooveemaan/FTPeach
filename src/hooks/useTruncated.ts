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
    const check = () => {
      if (el.scrollWidth > el.clientWidth + 1) {
        setTruncated(true);
        return;
      }
      // Integer scroll metrics miss fractional clipping. Measure text nodes
      // individually so header resize handles do not count as label content.
      const bounds = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let clipped = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        range.selectNodeContents(node);
        const textBounds = range.getBoundingClientRect();
        if (textBounds.width === 0) continue;
        // Range and element bounds may round differently (especially at a
        // fractional zoom). Ignore layout-unit noise, not a clipped pixel.
        const roundingTolerance = 0.05;
        if (
          textBounds.left < bounds.left - roundingTolerance ||
          textBounds.right > bounds.right + roundingTolerance
        ) {
          clipped = true;
          break;
        }
      }
      setTruncated(clipped);
    };
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
