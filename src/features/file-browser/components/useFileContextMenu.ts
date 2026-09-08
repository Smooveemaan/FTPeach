import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useRef, useState } from 'react';
import type { MenuItem } from '../../../components/MenuItems.tsx';
import type { FileEntry } from '../../../shared/types.ts';
import { formatBinding } from '../../../shortcuts/bindings.ts';
import type { ShortcutOverrides } from '../../../shortcuts/resolve.ts';
import { effectiveBinding } from '../../../shortcuts/resolve.ts';
import type { ColumnKey, Translate } from './fileListModel.ts';

interface RenameController {
  start: (entry: FileEntry) => void;
}

interface FileContextMenuOptions {
  getContextMenuItems?:
    | ((
        entry: FileEntry | null,
        options: { permanent: boolean; folderOrder: string[] },
      ) => MenuItem[])
    | undefined;
  folderOrder: string[];
  onRename?: ((entry: FileEntry, newName: string) => unknown) | undefined;
  rename: RenameController;
  availableColumns: readonly ColumnKey[];
  visibleColumns: readonly ColumnKey[];
  columnLabels: Record<ColumnKey, string>;
  toggleColumn: (key: ColumnKey) => void;
  resetColumnWidths: () => void;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
  t: Translate;
}

export interface OpenContextMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface FileContextMenuModel {
  menu: OpenContextMenu | null;
  close: () => void;
  openFiles: (event: ReactMouseEvent<HTMLElement>, entry: FileEntry | null) => void;
  openColumns: (event: ReactMouseEvent<HTMLElement>) => void;
}

export default function useFileContextMenu({
  getContextMenuItems,
  folderOrder,
  onRename,
  rename,
  availableColumns,
  visibleColumns,
  columnLabels,
  toggleColumn,
  resetColumnWidths,
  keyboardShortcuts,
  t,
}: FileContextMenuOptions): FileContextMenuModel {
  const [menu, setMenu] = useState<OpenContextMenu | null>(null);

  const optionsRef = useRef({
    getContextMenuItems,
    folderOrder,
    onRename,
    rename,
    keyboardShortcuts,
    t,
  });
  optionsRef.current = { getContextMenuItems, folderOrder, onRename, rename, keyboardShortcuts, t };

  const openFiles = useCallback((event: ReactMouseEvent<HTMLElement>, entry: FileEntry | null) => {
    const { getContextMenuItems, folderOrder, onRename, rename, keyboardShortcuts, t } =
      optionsRef.current;
    event.preventDefault();
    event.stopPropagation();
    const appItems = getContextMenuItems
      ? getContextMenuItems(entry, { permanent: event.shiftKey, folderOrder })
      : [];
    const [firstItem, ...restItems] = appItems;
    if (!firstItem) return;
    const items =
      entry && onRename
        ? [
            firstItem,
            {
              label: t('filePane.rename'),
              shortcut: formatBinding(effectiveBinding('rename', keyboardShortcuts)),
              onClick: () => rename.start(entry),
            },
            ...restItems,
          ]
        : appItems;
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  const openColumns = (event: ReactMouseEvent<HTMLElement>) => {
    if (availableColumns.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const items: MenuItem[] = [
      ...availableColumns.map((key) => ({
        label: columnLabels[key],
        checked: visibleColumns.includes(key),
        onClick: () => toggleColumn(key),
      })),
      { separator: true },
      { label: t('filePane.resetColumnWidths'), onClick: resetColumnWidths },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  return { menu, close: () => setMenu(null), openFiles, openColumns };
}
