import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { MenuBarEntry } from '../components/MenuBar.tsx';
import type { MenuItem } from '../components/MenuItems.tsx';
import { api } from '../platform/api/index.ts';
import type { AppMenuItemPayload, AppMenuModel } from '../platform/api/appMenu.ts';
import { hostPlatform } from '../platform/os.ts';

const KEY_NAME_MAP: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '/': 'Slash',
  '\\': 'Backslash',
  '=': 'Equal',
  '-': 'Minus',
  Return: 'Enter',
  '⌫': 'Backspace',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
};

export function macDisplayToMuda(shortcut?: string): string | undefined {
  if (!shortcut || typeof shortcut !== 'string') return undefined;
  if (shortcut.includes('+')) return shortcut;

  const mods: string[] = [];
  if (shortcut.includes('⌘')) mods.push('Cmd');
  if (shortcut.includes('⌃')) mods.push('Ctrl');
  if (shortcut.includes('⌥')) mods.push('Alt');
  if (shortcut.includes('⇧')) mods.push('Shift');

  const rawKey = shortcut.replace(/[⌃⌥⇧⌘]/g, '').trim();
  if (!rawKey) return undefined;
  const key = KEY_NAME_MAP[rawKey] ?? rawKey;

  return [...mods, key].join('+');
}

function toItemLabel(label: ReactNode): string | undefined {
  if (typeof label === 'string') return label;
  if (typeof label === 'number') return String(label);
  return undefined;
}

function toTopLabel(label: ReactNode): string {
  if (typeof label === 'string') return label;
  if (typeof label === 'number') return String(label);
  return '';
}

const TOP_MENU_IDS = ['file', 'edit', 'view', 'transfer', 'bookmarks', 'help'] as const;

export function useNativeAppMenu(menus: readonly MenuBarEntry[]): void {
  const callbacksRef = useRef<Map<string, () => void>>(new Map());

  // Listen to actions from macOS menu bar
  useEffect(() => {
    if (hostPlatform() !== 'macos') return;
    return api.appMenu.onAction((actionId: string) => {
      const cb = callbacksRef.current.get(actionId);
      if (cb) {
        cb();
      }
    });
  }, []);

  // Update menu model on native menu bar
  useEffect(() => {
    if (hostPlatform() !== 'macos') return;

    const callbacks = new Map<string, () => void>();
    let idCounter = 0;

    const convertItem = (item: MenuItem): AppMenuItemPayload => {
      if (item.separator) {
        return { separator: true };
      }
      const id = `item_${idCounter++}`;
      if (item.onClick) {
        callbacks.set(id, item.onClick);
      }
      const label = toItemLabel(item.label);
      const shortcut = macDisplayToMuda(item.shortcut);
      const children = item.submenu ? item.submenu.map(convertItem) : undefined;

      return {
        id: `app-menu:${id}`,
        label,
        disabled: item.disabled,
        checked: item.checked,
        shortcut,
        children,
      };
    };

    const model: AppMenuModel = {
      menus: menus.map((entry, index) => ({
        id: TOP_MENU_IDS[index] ?? `menu_${index}`,
        label: toTopLabel(entry.label),
        items: entry.items.map(convertItem),
      })),
    };

    callbacksRef.current = callbacks;
    void api.appMenu.setModel(model);
  }, [menus]);
}
