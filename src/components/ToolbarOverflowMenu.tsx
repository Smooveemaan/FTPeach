import { useTranslation } from 'react-i18next';
import Icon from './Icon.tsx';
import MenuItems from './MenuItems.tsx';
import type { MenuItem } from './MenuItems.tsx';
import { useAnchoredMenu } from '../hooks/useMenuPosition.ts';

interface ToolbarOverflowMenuProps {
  items: readonly MenuItem[];
}

export default function ToolbarOverflowMenu({ items }: ToolbarOverflowMenuProps) {
  const { t } = useTranslation();
  const { open, setOpen, rootRef, triggerRef, panelRef, panelPos } = useAnchoredMenu();

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
