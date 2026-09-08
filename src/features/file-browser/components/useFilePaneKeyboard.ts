import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback } from 'react';
import type { FileEntry } from '../../../shared/types.ts';
import type { ShortcutOverrides } from '../../../shortcuts/resolve.ts';
import { resolveAction } from '../../../shortcuts/resolve.ts';
import { isTextInput } from '../../../shortcuts/textInput.ts';

interface UseFilePaneKeyboardOptions {
  entries: readonly FileEntry[];
  sortedEntries: readonly FileEntry[];
  sortedFolderNames: string[];
  selectedNames: ReadonlySet<string>;
  keyboardShortcuts?: ShortcutOverrides | null | undefined;
  onSelectionChange: (selectedNames: Set<string>) => void;
  onStartRename?: ((entry: FileEntry) => void) | undefined;
  onDeleteSelected?: ((options?: { permanent?: boolean }) => unknown) | undefined;
  onNavigateUp?: (() => unknown) | undefined;
  onNavigateBack?: (() => unknown) | undefined;
  onNavigateForward?: (() => unknown) | undefined;
  onNavigateHome?: (() => unknown) | undefined;
  onMoveTo?: ((folderOrder: string[]) => unknown) | undefined;
  onNewFolder?: (() => unknown) | undefined;
  onNewFile?: (() => unknown) | undefined;
  onCopyToOtherPane?: (() => unknown) | undefined;
  onCopySelection?: (() => unknown) | undefined;
  onCutSelection?: (() => unknown) | undefined;
  onPaste?: (() => unknown) | undefined;
  onOpenEntry: (entry: FileEntry) => unknown;
  clearSelection: () => void;
  moveActive: (delta: number, extend: boolean) => void;
  jumpActive: (index: number, extend: boolean) => void;
  toggleActive: () => void;
  handleTypeahead: (character: string) => void;
}

export default function useFilePaneKeyboard({
  entries,
  sortedEntries,
  sortedFolderNames,
  selectedNames,
  keyboardShortcuts,
  onSelectionChange,
  onStartRename,
  onDeleteSelected,
  onNavigateUp,
  onNavigateBack,
  onNavigateForward,
  onNavigateHome,
  onMoveTo,
  onNewFolder,
  onNewFile,
  onCopyToOtherPane,
  onCopySelection,
  onCutSelection,
  onPaste,
  onOpenEntry,
  clearSelection,
  moveActive,
  jumpActive,
  toggleActive,
  handleTypeahead,
}: UseFilePaneKeyboardOptions): (event: ReactKeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || isTextInput(event.target)) return;
      const action = resolveAction(event.nativeEvent, 'pane', keyboardShortcuts);

      if (action === 'select-all') {
        onSelectionChange(new Set(sortedEntries.map((entry) => entry.name)));
        event.preventDefault();
        return;
      }
      if (event.target !== event.currentTarget) return;

      const findSelectedEntry = () => {
        if (selectedNames.size !== 1) return undefined;
        const selectedName = selectedNames.values().next().value;
        return entries.find((entry) => entry.name === selectedName);
      };

      if (action === 'rename' && onStartRename && selectedNames.size === 1) {
        const selectedEntry = findSelectedEntry();
        if (selectedEntry) onStartRename(selectedEntry);
      } else if (action === 'delete' && onDeleteSelected && selectedNames.size > 0) {
        onDeleteSelected({ permanent: false });
      } else if (action === 'delete-permanent' && onDeleteSelected && selectedNames.size > 0) {
        onDeleteSelected({ permanent: true });
      } else if (action === 'navigate-up' && onNavigateUp) {
        onNavigateUp();
      } else if (action === 'navigate-back' && onNavigateBack) {
        onNavigateBack();
      } else if (action === 'navigate-forward' && onNavigateForward) {
        onNavigateForward();
      } else if (action === 'navigate-home' && onNavigateHome) {
        onNavigateHome();
      } else if (action === 'move-to' && onMoveTo && selectedNames.size > 0) {
        onMoveTo(sortedFolderNames);
      } else if (action === 'new-folder' && onNewFolder) {
        onNewFolder();
      } else if (action === 'new-file' && onNewFile) {
        onNewFile();
      } else if (action === 'copy-to-other-pane' && onCopyToOtherPane && selectedNames.size > 0) {
        onCopyToOtherPane();
      } else if (action === 'copy' && onCopySelection && selectedNames.size > 0) {
        onCopySelection();
      } else if (action === 'cut' && onCutSelection && selectedNames.size > 0) {
        onCutSelection();
      } else if (action === 'paste' && onPaste) {
        onPaste();
      } else if (action === 'clear-selection' && selectedNames.size > 0) {
        clearSelection();
      } else if (action === 'open' && selectedNames.size === 1) {
        const selectedEntry = findSelectedEntry();
        if (selectedEntry) onOpenEntry(selectedEntry);
      } else if (event.key === 'ArrowDown') {
        moveActive(1, event.shiftKey);
      } else if (event.key === 'ArrowUp') {
        moveActive(-1, event.shiftKey);
      } else if (event.key === 'Home') {
        jumpActive(0, event.shiftKey);
      } else if (event.key === 'End') {
        jumpActive(sortedEntries.length - 1, event.shiftKey);
      } else if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        toggleActive();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        handleTypeahead(event.key);
      } else {
        return;
      }
      event.preventDefault();
    },
    [
      clearSelection,
      entries,
      handleTypeahead,
      jumpActive,
      keyboardShortcuts,
      moveActive,
      onCopySelection,
      onCopyToOtherPane,
      onCutSelection,
      onDeleteSelected,
      onNavigateBack,
      onNavigateForward,
      onNavigateHome,
      onNavigateUp,
      onNewFile,
      onNewFolder,
      onOpenEntry,
      onMoveTo,
      onPaste,
      onSelectionChange,
      onStartRename,
      selectedNames,
      sortedEntries,
      sortedFolderNames,
      toggleActive,
    ],
  );
}
