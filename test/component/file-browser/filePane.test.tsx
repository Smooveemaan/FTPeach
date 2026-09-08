import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { FilePane } from '../../../src/features/file-browser/index.ts';
import type { FilePaneProps } from '../../../src/features/file-browser/FilePane.tsx';
import * as fileListModel from '../../../src/features/file-browser/components/fileListModel.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';
import type { FileEntry } from '../../../src/shared/types.ts';

vi.mock('react-i18next', async (importOriginal) => {
  const stableT = (key: string) => key;
  return {
    ...(await importOriginal()),
    useTranslation: () => ({ t: stableT }),
  };
});

const entries: FileEntry[] = [
  { name: 'Zoo.txt', isDirectory: false, size: 30 },
  { name: 'Alpha', isDirectory: true, size: 0 },
  { name: 'beta.txt', isDirectory: false, size: 10 },
];

function renderPane(overrides: Partial<FilePaneProps> = {}) {
  const props = {
    side: 'a',
    kind: 'local',
    title: 'Computer',
    crumbs: [{ label: 'root', path: '/' }],
    entries,
    selectedNames: new Set<string>(),
    onCrumbClick: vi.fn(),
    onSelectionChange: vi.fn(),
    onRowDoubleClick: vi.fn(),
    loading: false,
    disconnected: false,
    onDropFiles: vi.fn(),
    dragMoveStart: vi.fn(),
    outboundDragRef: { current: false },
    onRename: vi.fn(async () => {}),
    onDeleteSelected: vi.fn(),
    onMoveTo: vi.fn(),
    onNavigateUp: vi.fn(),
    onNavigateBack: vi.fn(),
    onNavigateForward: vi.fn(),
    onNavigateHome: vi.fn(),
    onNewFolder: vi.fn(),
    onNewFile: vi.fn(),
    onCopyToOtherPane: vi.fn(),
    onCopySelection: vi.fn(),
    onCutSelection: vi.fn(),
    onPaste: vi.fn(),
    onPathSubmit: vi.fn(),
    getContextMenuItems: vi.fn(() => []),
    availableColumns: ['size'],
    visibleColumns: ['size'],
    columnWidths: {},
    ...overrides,
  } satisfies FilePaneProps;
  return { ...render(<FilePane {...props} />), props };
}

function requireHtml(element: Element | null): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element');
  return element;
}

describe('FilePane interactions', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.api = {
      ...tauriApi,
      fsLocal: {
        ...tauriApi.fsLocal,
        onOsDragDrop: vi.fn(() => vi.fn()),
        pathForFile: vi.fn((file: File) => `C:\\drop\\${file.name}`),
        isDir: vi.fn(async () => false),
      },
    };
  });

  test('leaves both panes unfocused until user interaction', async () => {
    const user = userEvent.setup();
    const left = renderPane({ side: 'a', onActivate: vi.fn() });
    const right = renderPane({ side: 'b', onActivate: vi.fn() });
    const leftPane = requireHtml(left.container.querySelector('.pane'));
    const rightPane = requireHtml(right.container.querySelector('.pane'));

    expect(document.activeElement).toBe(document.body);
    expect(left.props.onActivate).not.toHaveBeenCalled();
    expect(right.props.onActivate).not.toHaveBeenCalled();

    await user.click(leftPane);
    expect(document.activeElement).toBe(leftPane);
    expect(left.props.onActivate).toHaveBeenCalledOnce();

    await user.click(rightPane);
    expect(document.activeElement).toBe(rightPane);
    expect(right.props.onActivate).toHaveBeenCalledOnce();
  });

  test('selects, sorts, filters and supports keyboard actions', async () => {
    const user = userEvent.setup();
    const { container, props } = renderPane({ selectedNames: new Set(['beta.txt']) });
    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((row) => row.dataset.name),
    ).toEqual(['Alpha', 'beta.txt', 'Zoo.txt']);
    await user.click(within(list).getByRole('option', { name: /Zoo\.txt/ }));
    expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['Zoo.txt']));

    await user.click(screen.getByRole('button', { name: 'filePane.columnSize' }));
    expect(
      within(list)
        .getAllByRole('option')
        .map((row) => row.dataset.name),
    ).toEqual(['Alpha', 'beta.txt', 'Zoo.txt']);
    await user.click(screen.getByRole('button', { name: 'filePane.columnSize' }));
    expect(
      within(list)
        .getAllByRole('option')
        .map((row) => row.dataset.name),
    ).toEqual(['Alpha', 'Zoo.txt', 'beta.txt']);

    const searchToggle = requireHtml(container.querySelector('.pane-search-toggle'));
    await user.click(searchToggle);
    const search = screen.getByPlaceholderText('filePane.searchPlaceholder');
    await user.type(search, 'zoo');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByRole('option').dataset.name).toBe('Zoo.txt');

    await user.clear(search);
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();
    fireEvent.keyDown(pane, { key: 'Delete', code: 'Delete', shiftKey: true });
    expect(props.onDeleteSelected).toHaveBeenCalledWith({ permanent: true });
    fireEvent.keyDown(pane, { key: 'F2', code: 'F2' });
    const rename = requireHtml(container.querySelector('.rename-input'));
    await user.clear(rename);
    await user.type(rename, 'renamed.txt{Enter}');
    expect(props.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'beta.txt' }),
      'renamed.txt',
    );
  });

  test('leaves native scrollbar thumb drags to the browser', () => {
    renderPane();
    const list = screen.getByRole('listbox');
    const capture = vi.fn();
    Object.defineProperties(list, {
      offsetWidth: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 190 },
      offsetHeight: { configurable: true, value: 160 },
      clientHeight: { configurable: true, value: 150 },
      setPointerCapture: { configurable: true, value: capture },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          left: 20,
          top: 30,
          right: 220,
          bottom: 190,
          width: 200,
          height: 160,
          x: 20,
          y: 30,
          toJSON: () => ({}),
        }),
      },
    });

    fireEvent.pointerDown(list, { button: 0, pointerId: 1, clientX: 215, clientY: 80 });
    fireEvent.pointerDown(list, { button: 0, pointerId: 2, clientX: 100, clientY: 185 });

    expect(capture).not.toHaveBeenCalled();
  });

  test('focus returns to the pane after a rename commits, so arrow keys keep working', async () => {
    const user = userEvent.setup();
    const { container } = renderPane({ selectedNames: new Set(['beta.txt']) });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'F2', code: 'F2' });
    const input = requireHtml(container.querySelector('.rename-input'));
    await user.type(input, '{Enter}');

    expect(document.activeElement).toBe(pane);
  });

  test('Backspace navigates the pane up one directory level', () => {
    const { container, props } = renderPane({ onNavigateUp: vi.fn() });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'Backspace', code: 'Backspace' });

    expect(props.onNavigateUp).toHaveBeenCalledTimes(1);
  });

  test('Alt+Left/Right and Alt+Home navigate pane history and home', () => {
    const { container, props } = renderPane({
      onNavigateBack: vi.fn(),
      onNavigateForward: vi.fn(),
      onNavigateHome: vi.fn(),
    });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(props.onNavigateBack).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(props.onNavigateForward).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'Home', code: 'Home', altKey: true });
    expect(props.onNavigateHome).toHaveBeenCalledTimes(1);
  });

  test('F7/Shift+F7 create a new folder/file and F8 copies the selection to the other pane', () => {
    const { container, props } = renderPane({
      selectedNames: new Set(['beta.txt']),
      onNewFolder: vi.fn(),
      onNewFile: vi.fn(),
      onCopyToOtherPane: vi.fn(),
    });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'F7', code: 'F7' });
    expect(props.onNewFolder).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'F7', code: 'F7', shiftKey: true });
    expect(props.onNewFile).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'F8', code: 'F8' });
    expect(props.onCopyToOtherPane).toHaveBeenCalledTimes(1);
  });

  test('Ctrl+C/Ctrl+X mark the selection for the clipboard and Ctrl+V pastes it', () => {
    const { container, props } = renderPane({
      selectedNames: new Set(['beta.txt']),
      onCopySelection: vi.fn(),
      onCutSelection: vi.fn(),
      onPaste: vi.fn(),
    });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(props.onCopySelection).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'x', code: 'KeyX', ctrlKey: true });
    expect(props.onCutSelection).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'v', code: 'KeyV', ctrlKey: true });
    expect(props.onPaste).toHaveBeenCalledTimes(1);
  });

  test('Ctrl+C/X/V and Ctrl+A still work under a non-Latin keyboard layout', () => {
    const { container, props } = renderPane({
      selectedNames: new Set(['beta.txt']),
      onCopySelection: vi.fn(),
      onCutSelection: vi.fn(),
      onPaste: vi.fn(),
    });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'ψ', code: 'KeyC', ctrlKey: true });
    expect(props.onCopySelection).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'χ', code: 'KeyX', ctrlKey: true });
    expect(props.onCutSelection).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'ω', code: 'KeyV', ctrlKey: true });
    expect(props.onPaste).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(pane, { key: 'α', code: 'KeyA', ctrlKey: true });
    expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['Zoo.txt', 'Alpha', 'beta.txt']));
  });

  test('a keyboardShortcuts override remaps rename to its new binding and disables the old default', () => {
    const { container } = renderPane({
      selectedNames: new Set(['beta.txt']),
      keyboardShortcuts: { rename: 'Ctrl+KeyR' },
    });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    fireEvent.keyDown(pane, { key: 'F2', code: 'F2' });
    expect(container.querySelector('.rename-input')).toBeNull();

    fireEvent.keyDown(pane, { key: 'r', code: 'KeyR', ctrlKey: true });
    expect(container.querySelector('.rename-input')).not.toBeNull();
  });

  test('Space toggles the active row in/out of the selection without moving the cursor', () => {
    const { container, props } = renderPane({ selectedNames: new Set() });
    const pane = requireHtml(container.querySelector('.pane'));
    pane.focus();

    // No row is active yet (nothing clicked/arrowed to) — Space falls back
    // to the first row, same as ArrowDown's own no-active-row fallback.
    fireEvent.keyDown(pane, { key: ' ' });
    expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['Alpha']));

    const { container: container2, props: props2 } = renderPane({
      selectedNames: new Set(['Alpha']),
    });
    const pane2 = requireHtml(container2.querySelector('.pane'));
    pane2.focus();

    fireEvent.keyDown(pane2, { key: ' ' });
    expect(props2.onSelectionChange).toHaveBeenCalledWith(new Set());
  });

  test('forwards an operating-system file drop through the pane boundary', () => {
    const { props } = renderPane();
    const list = screen.getByRole('listbox');
    const files = [new File(['payload'], 'upload.txt')];
    fireEvent.drop(list, { dataTransfer: { files, items: [], types: ['Files'] } });
    expect(props.onDropFiles).toHaveBeenCalledWith(
      [{ name: 'upload.txt', path: 'C:\\drop\\upload.txt', isDirectory: false }],
      null,
    );
  });

  test('Ctrl+A selects every file even while a descendant control (not .pane itself) has focus', () => {
    const { props } = renderPane();
    const columnHeader = screen.getByRole('button', { name: 'filePane.columnSize' });
    columnHeader.focus();
    expect(document.activeElement).toBe(columnHeader);

    fireEvent.keyDown(columnHeader, { key: 'a', code: 'KeyA', ctrlKey: true });

    expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['Zoo.txt', 'Alpha', 'beta.txt']));
  });

  test('starts a pane-to-pane drag with the current multi-selection', () => {
    const { props } = renderPane({ selectedNames: new Set(['Zoo.txt', 'beta.txt']) });
    const row = within(screen.getByRole('listbox')).getByRole('option', { name: /Zoo\.txt/ });

    fireEvent.mouseDown(row, { button: 0, clientX: 25, clientY: 40 });

    expect(props.dragMoveStart).toHaveBeenCalledTimes(1);
    expect(props.dragMoveStart).toHaveBeenCalledWith(
      'a',
      expect.arrayContaining(['Zoo.txt', 'beta.txt']),
      expect.objectContaining({ name: 'Zoo.txt', isDirectory: false }),
      expect.objectContaining({ button: 0 }),
    );
  });

  test('right-click selects an unselected row before opening its context menu', () => {
    const { props } = renderPane({ selectedNames: new Set(['beta.txt']) });
    const row = within(screen.getByRole('listbox')).getByRole('option', { name: /Zoo\.txt/ });

    fireEvent.contextMenu(row);

    expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['Zoo.txt']));
  });

  test('right-click on a row already part of a multi-selection leaves the selection untouched', () => {
    const { props } = renderPane({ selectedNames: new Set(['Zoo.txt', 'beta.txt']) });
    const row = within(screen.getByRole('listbox')).getByRole('option', { name: /Zoo\.txt/ });

    fireEvent.contextMenu(row);

    expect(props.onSelectionChange).not.toHaveBeenCalled();
  });

  describe('row interactions stay correct across a re-render the row itself skips', () => {
    test('Ctrl+click toggles against the current selection, not the one from before the last re-render', () => {
      const { props, rerender } = renderPane({ selectedNames: new Set(['beta.txt']) });
      // 'Zoo.txt' is unselected in both this render and the next — its own
      // `selected` prop never changes, so FileRow is free to memo-bail on it.
      rerender(<FilePane {...props} selectedNames={new Set(['Alpha'])} />);

      const row = within(screen.getByRole('listbox')).getByRole('option', { name: /Zoo\.txt/ });
      fireEvent.click(row, { ctrlKey: true });

      // A stale closure would toggle against the render-1 selection
      // (Set(['beta.txt'])) and report Set(['beta.txt', 'Zoo.txt']) instead.
      expect(props.onSelectionChange).toHaveBeenCalledWith(new Set(['Alpha', 'Zoo.txt']));
    });

    test('starting a drag picks up the current multi-selection, not the one from before the last re-render', () => {
      const { props, rerender } = renderPane({
        selectedNames: new Set(['Zoo.txt', 'beta.txt']),
      });
      // 'Zoo.txt' stays selected across both renders — its `selected` prop
      // never changes even though the rest of the selection does.
      rerender(<FilePane {...props} selectedNames={new Set(['Zoo.txt', 'Alpha'])} />);

      const row = within(screen.getByRole('listbox')).getByRole('option', { name: /Zoo\.txt/ });
      fireEvent.mouseDown(row, { button: 0, clientX: 25, clientY: 40 });

      // A stale closure would drag the render-1 selection (['Zoo.txt',
      // 'beta.txt']) instead of the current one.
      expect(props.dragMoveStart).toHaveBeenCalledWith(
        'a',
        expect.arrayContaining(['Zoo.txt', 'Alpha']),
        expect.objectContaining({ name: 'Zoo.txt' }),
        expect.anything(),
      );
    });
  });

  test('a row whose own props are unchanged skips re-rendering across an unrelated pane re-render', () => {
    const iconSpy = vi.spyOn(fileListModel, 'fileIconName');
    const { props, rerender } = renderPane({ selectedNames: new Set(['beta.txt']) });
    iconSpy.mockClear();

    rerender(<FilePane {...props} getContextMenuItems={() => []} />);

    expect(iconSpy).not.toHaveBeenCalled();
    iconSpy.mockRestore();
  });
});
