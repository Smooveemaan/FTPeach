import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import MenuItems from './MenuItems.tsx';
import type { MenuItem } from './MenuItems.tsx';
import { getInterfaceScale } from '../platform/interfaceScale.ts';
import useDismissableOverlay from '../hooks/useDismissableOverlay.ts';

interface ContextMenuProps {
  x: number;
  y: number;
  /**
   * For a menu opened from a button: the button's top edge. Without room
   * below `y`, the menu opens upward from here instead of being pushed up
   * over the button, where it would block pressing the button again.
   */
  aboveY?: number | undefined;
  items: readonly MenuItem[];
  onClose: () => void;
  className?: string;
  /**
   * The width the menu starts at. It grows past this whenever a label needs
   * the room -- translations run well past the English they were sized for
   * -- so this is a floor, not a size.
   */
  minWidth?: number;
}

export default function ContextMenu({
  x,
  y,
  aboveY,
  items,
  onClose,
  className = '',
  minWidth = 220,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const previouslyFocusedRef = useRef(document.activeElement);

  /**
   * Placement clamps against the menu's real width, which only the browser
   * knows once the labels are laid out. The first pass positions from
   * `minWidth`; this measurement corrects it before the paint, so a menu
   * that grew still stops at the viewport edge instead of running off it.
   */
  const [renderedWidth, setRenderedWidth] = useState(0);
  useLayoutEffect(() => setRenderedWidth(ref.current?.offsetWidth ?? 0), [items]);

  const dismiss = useCallback(() => onCloseRef.current(), []);
  useDismissableOverlay({
    open: true,
    rootRef: ref,
    onDismiss: dismiss,
    restoreFocusRef: previouslyFocusedRef,
  });

  const rtl = document.documentElement.dir === 'rtl';
  const scale = getInterfaceScale();
  const localX = x / scale;
  const localY = y / scale;
  const localWidth = window.innerWidth / scale;
  const localHeight = window.innerHeight / scale;
  const menuWidth = Math.min(Math.max(minWidth, renderedWidth), localWidth);
  const preferredLeft = rtl ? localX - menuWidth : localX;
  const left = Math.max(0, Math.min(preferredLeft, localWidth - menuWidth));
  const estimatedHeight = items.length * 28 + 40;
  const openAbove = aboveY != null && localY + estimatedHeight > localHeight;
  const style: CSSProperties = {
    [rtl ? 'right' : 'left']: rtl ? localWidth - left - menuWidth : left,
    ...(openAbove
      ? { bottom: localHeight - aboveY / scale }
      : { top: Math.max(0, Math.min(localY, localHeight - estimatedHeight)) }),
    minWidth,
    width: 'max-content',
    maxWidth: localWidth,
  };

  return (
    <div className={`context-menu ${className}`.trim()} style={style} ref={ref}>
      <MenuItems items={items} onAction={onClose} />
    </div>
  );
}
