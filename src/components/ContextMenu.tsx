import { useCallback, useRef } from 'react';
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
  width?: number;
}

export default function ContextMenu({
  x,
  y,
  aboveY,
  items,
  onClose,
  className = '',
  width = 220,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const previouslyFocusedRef = useRef(document.activeElement);

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
  const preferredLeft = rtl ? localX - width : localX;
  const left = Math.max(0, Math.min(preferredLeft, localWidth - width));
  const estimatedHeight = items.length * 28 + 40;
  const openAbove = aboveY != null && localY + estimatedHeight > localHeight;
  const style: CSSProperties = {
    [rtl ? 'right' : 'left']: rtl ? localWidth - left - width : left,
    ...(openAbove
      ? { bottom: localHeight - aboveY / scale }
      : { top: Math.max(0, Math.min(localY, localHeight - estimatedHeight)) }),
    width,
  };

  return (
    <div className={`context-menu ${className}`.trim()} style={style} ref={ref}>
      <MenuItems items={items} onAction={onClose} />
    </div>
  );
}
