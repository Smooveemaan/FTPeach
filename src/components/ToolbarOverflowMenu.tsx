import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon.tsx';
import MenuItems from './MenuItems.tsx';
import type { MenuItem } from './MenuItems.tsx';
import { useAnchoredOverlay } from '../hooks/useMenuPosition.ts';
import useDismissableOverlay from '../hooks/useDismissableOverlay.ts';

interface ToolbarOverflowMenuProps {
  items: readonly MenuItem[];
}

export default function ToolbarOverflowMenu({ items }: ToolbarOverflowMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelPos = useAnchoredOverlay(open, triggerRef, panelRef);

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissableOverlay({ open, rootRef, onDismiss: dismiss, restoreFocusRef: triggerRef });

  const toggleOpen = () => setOpen((v) => !v);

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
          ref={panelRef}
          className="menu-dropdown toolbar-overflow-menu"
          style={{ top: panelPos.top, insetInlineStart: panelPos.inlineStart }}
        >
          <MenuItems items={items} onAction={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
