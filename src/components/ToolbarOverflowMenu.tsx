import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon.tsx';
import MenuItems from './MenuItems.tsx';
import type { MenuItem } from './MenuItems.tsx';
import { getInterfaceScale } from '../platform/interfaceScale.ts';
import useDismissableOverlay from '../hooks/useDismissableOverlay.ts';

interface PanelPosition {
  top: number;
  inlineStart: number;
}

interface ToolbarOverflowMenuProps {
  items: readonly MenuItem[];
}

export default function ToolbarOverflowMenu({ items }: ToolbarOverflowMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<PanelPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissableOverlay({ open, rootRef, onDismiss: dismiss, restoreFocusRef: triggerRef });

  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      if (next && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const scale = getInterfaceScale();
        const viewportWidth = window.innerWidth / scale;
        const inlineStart =
          document.documentElement.dir === 'rtl'
            ? viewportWidth - rect.right / scale
            : rect.left / scale;
        setPanelPos({
          top: Math.min(
            (rect.bottom + 2) / scale,
            window.innerHeight / scale - items.length * 28 - 40,
          ),
          inlineStart: Math.max(8, inlineStart),
        });
      }
      return next;
    });
  };

  return (
    <div className="toolbar-overflow-anchor" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`btn btn-ghost btn-icon ${open ? 'active' : ''}`}
        aria-label={t('toolbarOverflowMenu.more')}
        aria-expanded={open}
        data-tooltip={t('toolbarOverflowMenu.more')}
        onClick={toggleOpen}
      >
        <Icon name="moreHorizontal" />
      </button>

      {open && panelPos && (
        <div
          className="menu-dropdown toolbar-overflow-menu"
          style={{ top: panelPos.top, insetInlineStart: panelPos.inlineStart }}
        >
          <MenuItems items={items} onAction={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
