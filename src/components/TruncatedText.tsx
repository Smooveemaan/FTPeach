import type { ReactNode } from 'react';
import { useTruncated } from '../hooks/useTruncated.ts';

interface TruncatedTextProps {
  className: string;
  children: ReactNode;
  /** Matches the wrapped element to whatever block/inline behavior the
   * caller's layout expects (e.g. a block-level row label needs `div` to
   * actually fill its container's width — an inline `span` would just
   * shrink to fit its content and never register as overflowing). */
  as?: 'span' | 'div';
}

/** An element that fades its own text out only once it actually overflows —
 * see the `.truncated` CSS variants this pairs with. Lets list rows (menu
 * items, select options, site names, ...) opt into that behavior without
 * each hand-rolling the ResizeObserver/scrollWidth check. */
export default function TruncatedText({ className, children, as = 'span' }: TruncatedTextProps) {
  const [ref, truncated] = useTruncated<HTMLElement>([children]);
  const fullClassName = `${className}${truncated ? ' truncated' : ''}`;
  if (as === 'div') {
    return (
      <div ref={ref as never} className={fullClassName}>
        {children}
      </div>
    );
  }
  return (
    <span ref={ref} className={fullClassName}>
      {children}
    </span>
  );
}
