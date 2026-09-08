import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import MenuItems from './MenuItems.tsx';
import type { MenuItem } from './MenuItems.tsx';
import useDismissableOverlay from '../hooks/useDismissableOverlay.ts';

export interface MenuBarEntry {
  label: ReactNode;
  items: readonly MenuItem[];
}

interface MenuBarProps {
  menus: readonly MenuBarEntry[];
}

export default function MenuBar({ menus }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleTriggerKeyDown = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = document.documentElement.dir === 'rtl';
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = (i + (rtl ? -1 : 1) + menus.length) % menus.length;
      triggerRefs.current[next]?.focus();
      if (openIndex !== null) setOpenIndex(next);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = (i + (rtl ? 1 : -1) + menus.length) % menus.length;
      triggerRefs.current[prev]?.focus();
      if (openIndex !== null) setOpenIndex(prev);
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpenIndex(i);
    }
  };

  const closeMenu = (index: number) => {
    setOpenIndex(null);
    triggerRefs.current[index]?.focus();
  };

  const dismissMenu = useCallback(() => setOpenIndex(null), []);
  useDismissableOverlay({ open: openIndex !== null, rootRef, onDismiss: dismissMenu });

  return (
    <div className="menu-bar" role="menubar" ref={rootRef}>
      {menus.map((menu, i) => (
        <div className="menu-bar-item" key={i}>
          <button
            type="button"
            ref={(el) => {
              triggerRefs.current[i] = el;
            }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openIndex === i}
            className={`menu-bar-trigger ${openIndex === i ? 'active' : ''}`}
            onClick={() => setOpenIndex((prev) => (prev === i ? null : i))}
            onKeyDown={handleTriggerKeyDown(i)}
            onMouseEnter={() => {
              if (openIndex !== null) setOpenIndex(i);
            }}
          >
            {menu.label}
          </button>
          {openIndex === i && (
            <div className="menu-dropdown">
              <MenuItems items={menu.items} onAction={() => closeMenu(i)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
