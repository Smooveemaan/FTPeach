import type { RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

/** Whether the element, or any `.fit-shrink` inside it, cuts its content off. */
function overflows(el: HTMLElement): boolean {
  const cut = (node: Element) => node.scrollWidth > node.clientWidth + 1;
  return cut(el) || Array.from(el.querySelectorAll('.fit-shrink')).some(cut);
}

/**
 * How far a status line has to compact itself to fit: 0 shows everything in
 * full, each level up is one more step of shortening, decided by the caller.
 * It steps up while something is cut off, before the browser paints, and starts
 * over from 0 when `content` changes. `content` should name whatever changes
 * the line's text.
 *
 * Resizing the window must stay cheap: it notes the width at which each level
 * stopped fitting, and only re-renders when the line crosses one of those
 * widths or something is actually cut off -- not on every frame of a drag.
 */
export function useFitLevel<T extends HTMLElement>(
  maxLevel: number,
  content: string,
): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [fit, setFit] = useState({ content, level: 0 });
  if (fit.content !== content) setFit({ content, level: 0 });
  const level = fit.content === content ? fit.level : 0;
  // tooWideAt[n]: the line's width when level n was found not to fit.
  const tooWideAt = useRef<number[]>([]);
  const levelRef = useRef(level);

  useLayoutEffect(() => {
    tooWideAt.current = [];
  }, [content]);

  useLayoutEffect(() => {
    levelRef.current = level;
    const el = ref.current;
    if (el && level < maxLevel && overflows(el)) {
      tooWideAt.current[level] = el.clientWidth;
      setFit({ content, level: level + 1 });
    }
  }, [content, level, maxLevel]);

  // Sizes change without new content too: the window resizes, or a part the
  // caller does not list in `content` (an update's progress) grows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      let next = levelRef.current;
      // Wider than where the fuller form stopped fitting: try it again.
      while (next > 0 && width > (tooWideAt.current[next - 1] ?? Infinity)) next -= 1;
      if (next === levelRef.current && next < maxLevel && overflows(el)) {
        tooWideAt.current[next] = width;
        next += 1;
      }
      if (next !== levelRef.current) {
        levelRef.current = next;
        setFit((current) => ({ ...current, level: next }));
      }
    });
    observer.observe(el);
    el.querySelectorAll('.fit-shrink').forEach((part) => observer.observe(part));
    return () => observer.disconnect();
  }, [content, maxLevel]);

  return [ref, level];
}
