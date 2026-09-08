import { useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import MenuItems from './MenuItems.tsx';
import type { MenuItem } from './MenuItems.tsx';
import { getInterfaceScale } from '../platform/interfaceScale.ts';
import useDismissableOverlay from '../hooks/useDismissableOverlay.ts';

interface ContextMenuProps {
  x: number;
  y: number;
  items: readonly MenuItem[];
  onClose: () => void;
  className?: string;
  width?: number;
}

export default function ContextMenu({
  x,
  y,
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
  const style: CSSProperties = {
    [rtl ? 'right' : 'left']: rtl ? localWidth - left - width : left,
    top: Math.max(0, Math.min(localY, localHeight - items.length * 28 - 40)),
    width,
  };

  return (
    <div className={`context-menu ${className}`.trim()} style={style} ref={ref}>
      <MenuItems items={items} onAction={onClose} />
    </div>
  );
}
