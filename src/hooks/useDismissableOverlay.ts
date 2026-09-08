import type { RefObject } from 'react';
import { useEffect } from 'react';

interface DismissableOverlayOptions {
  open: boolean;
  rootRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  restoreFocusRef?: RefObject<Element | null>;
}

export default function useDismissableOverlay({
  open,
  rootRef,
  onDismiss,
  restoreFocusRef,
}: DismissableOverlayOptions): void {
  useEffect(() => {
    if (!open) return undefined;
    const dismissOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onDismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onDismiss();
      const restoreTarget = restoreFocusRef?.current;
      if (restoreTarget instanceof HTMLElement && document.contains(restoreTarget)) {
        restoreTarget.focus();
      }
    };
    document.addEventListener('mousedown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('mousedown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [onDismiss, open, restoreFocusRef, rootRef]);
}
