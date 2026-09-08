import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import TruncatedText from './TruncatedText.tsx';

export interface MenuItem {
  label?: ReactNode | undefined;
  separator?: boolean | undefined;
  danger?: boolean | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
  glyph?: ReactNode | undefined;
  checked?: boolean | undefined;
  icon?: ReactNode | undefined;
  shortcut?: string | undefined;
  scrollStart?: boolean | undefined;
}

interface MenuItemsProps {
  items: readonly MenuItem[];
  onAction: () => void;
}

export default function MenuItems({ items, onAction }: MenuItemsProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    );
    first?.focus();
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const entries = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) || [],
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
    else next = current < 0 ? entries.length - 1 : (current - 1 + entries.length) % entries.length;
    entries[next]?.focus();
  };

  const renderItem = (item: MenuItem, i: number) =>
    item.separator ? (
      <div className="menu-separator" key={`sep-${i}`} />
    ) : (
      <button
        type="button"
        key={typeof item.label === 'string' ? item.label : `item-${i}`}
        role="menuitem"
        className={`menu-item ${item.danger ? 'danger' : ''} ${item.className || ''}`}
        disabled={item.disabled}
        onClick={() => {
          onAction();
          item.onClick?.();
        }}
      >
        {/* glyph overrides the plain checkmark for items that need a
            different marker (PaneSourceSwitcher's "+" on "new
            connection") — falls back to the usual checked/unchecked
            behavior when unset. */}
        <span className="menu-item-check">{item.glyph ?? (item.checked ? '✓' : '')}</span>
        {item.icon && <span className="menu-item-icon">{item.icon}</span>}
        <TruncatedText className="menu-item-label">{item.label}</TruncatedText>
        {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
      </button>
    );

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
