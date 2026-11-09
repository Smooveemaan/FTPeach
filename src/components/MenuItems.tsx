import { focusMenuItem } from './focusMenuItem.ts';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import TruncatedText from './TruncatedText.tsx';
import { getInterfaceScale } from '../platform/interfaceScale.ts';

export interface MenuItem {
  label?: ReactNode | undefined;
  separator?: boolean | undefined;
  danger?: boolean | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
  glyph?: ReactNode | undefined;
  /** Set on an item that is on or off; screen readers are told which. */
  checked?: boolean | undefined;
  /** One choice of a set where only one is on, rather than a toggle of its own. */
  radio?: boolean | undefined;
  /** A toggle that leaves the menu open, so several can be set in a row. */
  keepOpen?: boolean | undefined;
  icon?: ReactNode | undefined;
  shortcut?: string | undefined;
  scrollStart?: boolean | undefined;
  submenu?: readonly MenuItem[] | undefined;
}

interface MenuItemsProps {
  items: readonly MenuItem[];
  onAction: () => void;
  onCloseSubmenu?: () => void;
}

/** Every item keyboard navigation moves through, whatever kind it is. */
const ENTRIES =
  ':is(button[role="menuitem"], button[role="menuitemcheckbox"], button[role="menuitemradio"]):not(:disabled)';

const itemRole = (item: MenuItem) =>
  item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox';

export default function MenuItems({ items, onAction, onCloseSubmenu }: MenuItemsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>(ENTRIES);
    focusMenuItem(first);
  }, []);

  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const entries = Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>(ENTRIES) || [],
      );
      if (entries.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const activeElement = document.activeElement;
      const current =
        activeElement instanceof HTMLButtonElement ? entries.indexOf(activeElement) : -1;
      let next;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = entries.length - 1;
      else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % entries.length;
      else
        next = current < 0 ? entries.length - 1 : (current - 1 + entries.length) % entries.length;
      focusMenuItem(entries[next]);
      return;
    }

    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
      const activeElement = document.activeElement;
      const current =
        activeElement instanceof HTMLButtonElement ? itemRefs.current.indexOf(activeElement) : -1;
      if (
        current >= 0 &&
        !items[current]?.disabled &&
        items[current]?.submenu &&
        items[current].submenu.length > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        setActiveSubmenu(current);
      }
      return;
    }

    if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
      if (onCloseSubmenu) {
        e.preventDefault();
        e.stopPropagation();
        onCloseSubmenu();
      }
    }
  };

  const getSubmenuStyle = (index: number): CSSProperties => {
    const el = itemRefs.current[index];
    if (!el || typeof window === 'undefined') return { position: 'fixed', zIndex: 250 };
    const rect = el.getBoundingClientRect();
    const scale = getInterfaceScale();
    const minWidth = 220;
    const localRight = rect.right / scale;
    const localLeft = rect.left / scale;
    const localTop = rect.top / scale;
    const viewportWidth = window.innerWidth / scale;
    const fitsOnRight = localRight + minWidth <= viewportWidth;
    const left = rtl
      ? localLeft - minWidth >= 0
        ? localLeft - minWidth
        : localRight
      : fitsOnRight
        ? localRight - 2
        : Math.max(0, localLeft - minWidth);
    return {
      position: 'fixed',
      left: `${left}px`,
      top: `${Math.max(0, localTop - 4)}px`,
      minWidth: `${minWidth}px`,
      zIndex: 250,
    };
  };

  const renderItem = (item: MenuItem, i: number) => {
    if (item.separator) {
      return <div className="menu-separator" key={`sep-${i}`} />;
    }
    const hasSubmenu = Boolean(item.submenu && item.submenu.length > 0);
    const isOpen = activeSubmenu === i;
    return (
      <div
        className="menu-item-row"
        key={typeof item.label === 'string' ? item.label : `item-${i}`}
        onMouseEnter={() => {
          if (item.disabled) {
            setActiveSubmenu(null);
            return;
          }
          if (hasSubmenu) setActiveSubmenu(i);
          else setActiveSubmenu(null);
        }}
      >
        <button
          type="button"
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          role={itemRole(item)}
          aria-haspopup={hasSubmenu ? 'menu' : undefined}
          aria-expanded={hasSubmenu ? isOpen : undefined}
          aria-checked={item.checked}
          aria-keyshortcuts={item.shortcut?.replace(/\bCtrl\b/, 'Control') || undefined}
          className={`menu-item ${item.danger ? 'danger' : ''} ${item.className || ''}`}
          disabled={item.disabled}
          onClick={() => {
            if (hasSubmenu) {
              setActiveSubmenu(isOpen ? null : i);
              return;
            }
            if (!item.keepOpen) onAction();
            item.onClick?.();
          }}
        >
          {/* glyph overrides the plain checkmark for items that need a
              different marker (PaneSourceSwitcher's "+" on "new
              connection") — falls back to the usual checked/unchecked
              behavior when unset. */}
          <span className="menu-item-check" aria-hidden="true">
            {item.glyph ?? (item.checked ? '✓' : '')}
          </span>
          {item.icon && <span className="menu-item-icon">{item.icon}</span>}
          <TruncatedText className="menu-item-label">{item.label}</TruncatedText>
          {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
          {hasSubmenu && (
            <span className="menu-item-arrow" aria-hidden="true">
              ›
            </span>
          )}
        </button>
        {hasSubmenu && isOpen && (
          <div className="context-menu context-submenu" style={getSubmenuStyle(i)}>
            <MenuItems
              items={item.submenu!}
              onAction={onAction}
              onCloseSubmenu={() => {
                setActiveSubmenu(null);
                focusMenuItem(itemRefs.current[i]);
              }}
            />
          </div>
        )}
      </div>
    );
  };

  const scrollIndex = items.findIndex((item) => item.scrollStart);
  const leading = scrollIndex === -1 ? items : items.slice(0, scrollIndex);
  const scrollable = scrollIndex === -1 ? [] : items.slice(scrollIndex);

  return (
    <div className="menu-items" role="menu" ref={rootRef} onKeyDown={handleKeyDown}>
      {leading.map(renderItem)}
      {scrollable.length > 0 && (
        <div className="menu-items-scroll">
          {scrollable.map((item, i) => renderItem(item, scrollIndex + i))}
        </div>
      )}
    </div>
  );
}
