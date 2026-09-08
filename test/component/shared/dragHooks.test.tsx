import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useColumnResize } from '../../../src/hooks/useColumnResize.ts';
import { useColumnDragReorder } from '../../../src/hooks/useColumnDragReorder.ts';
import { useDragMove } from '../../../src/features/file-browser/components/useDragMove.ts';
import { useSectionResize } from '../../../src/app/layout/useSectionResize.ts';
import { useTransferLogSplit } from '../../../src/app/layout/useTransferLogSplit.ts';
import { persistSetting } from '../../../src/platform/persistSetting.ts';

vi.mock('../../../src/platform/persistSetting.ts', () => ({ persistSetting: vi.fn() }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.dir = '';
  document.body.className = '';
  document.body.style.cssText = '';
  vi.useRealTimers();
  vi.clearAllMocks();
});

function element(direction: string, left = 100, width = 400) {
  const el = document.createElement('div');
  el.style.direction = direction;
  document.body.append(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 400,
    height: 400,
    x: left,
    y: 0,
    toJSON: () => ({}),
  });
  return el;
}

function down(target: HTMLElement, clientX = 100): ReactMouseEvent<HTMLElement> {
  return {
    currentTarget: target,
    target,
    clientX,
    clientY: 100,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as ReactMouseEvent<HTMLElement>;
}

function columnHeaders(direction: string) {
  const container = element(direction, direction === 'rtl' ? 100 : 0, 200);
  container.style.display = 'grid';
  container.style.gridTemplateColumns = '100px 100px';
  const name = element(direction, direction === 'rtl' ? 200 : 0, 100);
  const size = element(direction, 100, 100);
  container.append(name, size);
  return { container, name, size };
}

test.each(['ltr', 'rtl'])(
  'column resize uses the handle direction and releases listeners in %s',
  (direction) => {
    const el = element(direction);
    const resize = vi.fn();
    const end = vi.fn();
    const { result } = renderHook(() => useColumnResize());
    act(() =>
      result.current.startColumnResize({
        startWidth: 100,
        minWidth: 80,
        onResize: resize,
        onResizeEnd: end,
      })(down(el)),
    );
    fireEvent.mouseMove(document, { clientX: 130, buttons: 1 });
    expect(resize).toHaveBeenLastCalledWith(direction === 'rtl' ? 80 : 130);
    fireEvent.blur(window);
    expect(end).toHaveBeenCalledTimes(1);
    fireEvent.mouseMove(document, { clientX: 160, buttons: 1 });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('column-resize-active')).toBe(false);
  },
);

test.each(['ltr', 'rtl'])(
  'transfer/log split mirrors ratios, clamps and persists on release in %s',
  (direction) => {
    const el = element(direction);
    const { result } = renderHook(() => useTransferLogSplit());
    result.current.transferLogRef.current = el;
    act(() => result.current.startTransferLogResize(down(el)));
    fireEvent.mouseMove(document, { clientX: 200, buttons: 1 });
    expect(result.current.transferLogSplitRatio).toBe(direction === 'rtl' ? 0.75 : 0.25);
    fireEvent.mouseMove(document, { clientX: 600, buttons: 1 });
    expect(result.current.transferLogSplitRatio).toBe(direction === 'rtl' ? 0.2 : 0.8);
    fireEvent.mouseUp(document);
    expect(persistSetting).toHaveBeenLastCalledWith({
      transferLogSplitRatio: direction === 'rtl' ? 0.2 : 0.8,
    });
    expect(result.current.resizingTransferLog).toBe(false);
  },
);

test.each(['ltr', 'rtl'])(
  'pane split mirrors pointer position and cleans up the drag session in %s',
  (direction) => {
    const el = element(direction, 100, 1000);
    const { result, unmount } = renderHook(() =>
      useSectionResize({
        showTransferQueue: false,
        logEnabled: false,
        paneOrientation: 'horizontal',
        windowNarrow: false,
      }),
    );
    result.current.panesRef.current = el;
    document.body.style.cursor = 'crosshair';
    act(() => result.current.startResize(down(el)));
    fireEvent.mouseMove(document, { clientX: 500, buttons: 1 });
    expect(result.current.splitRatio).toBe(direction === 'rtl' ? 0.6 : 0.4);
    unmount();
    expect(document.body.style.cursor).toBe('crosshair');
    fireEvent.mouseUp(document);
    expect(persistSetting).not.toHaveBeenCalled();
  },
);

test.each(['ltr', 'rtl'])(
  'column reorder crosses the logical midpoint and Escape restores order in %s',
  (direction) => {
    vi.useFakeTimers();
    document.documentElement.dir = direction;
    const { name, size: header } = columnHeaders(direction);
    header.dataset.columnKey = 'size';
    const reorder = vi.fn();
    const { result } = renderHook(() =>
      useColumnDragReorder({ order: ['name', 'size'], onReorder: reorder }),
    );
    result.current.registerHeaderRef('size')(header);
    result.current.registerHeaderRef('name')(name);
    act(() =>
      result.current
        .getDragHandleProps('name')
        .onMouseDown(down(header, direction === 'rtl' ? 250 : 50)),
    );
    fireEvent.mouseMove(header, { clientX: 150, buttons: 1 });
    act(() => vi.advanceTimersByTime(20));
    expect(reorder).not.toHaveBeenCalled();
    fireEvent.mouseMove(header, { clientX: direction === 'rtl' ? 130 : 170, buttons: 1 });
    act(() => vi.advanceTimersByTime(20));
    expect(reorder).toHaveBeenLastCalledWith(['size', 'name']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(reorder).toHaveBeenLastCalledWith(['name', 'size']);
    expect(result.current.draggedColumn).toBeNull();
  },
);

test.each([
  ['ltr', -100],
  ['ltr', 600],
  ['rtl', -100],
  ['rtl', 600],
] as const)('column reorder works outside the headers in %s at y=%s', (direction, clientY) => {
  vi.useFakeTimers();
  document.documentElement.dir = direction;
  const { name, size: header } = columnHeaders(direction);
  header.dataset.columnKey = 'size';
  const otherPane = element(direction, 100, 100);
  otherPane.dataset.columnKey = 'name';
  const reorder = vi.fn();
  const { result } = renderHook(() =>
    useColumnDragReorder({ order: ['name', 'size'], onReorder: reorder }),
  );
  result.current.registerHeaderRef('size')(header);
  result.current.registerHeaderRef('name')(name);
  act(() =>
    result.current
      .getDragHandleProps('name')
      .onMouseDown(down(header, direction === 'rtl' ? 250 : 50)),
  );
  fireEvent.mouseMove(otherPane, {
    clientX: direction === 'rtl' ? 130 : 170,
    clientY,
    buttons: 1,
  });
  act(() => vi.advanceTimersByTime(20));
  expect(reorder).toHaveBeenLastCalledWith(['size', 'name']);
  fireEvent.mouseUp(document);
  expect(result.current.draggedColumn).toBeNull();
  reorder.mockClear();
  fireEvent.mouseMove(document, { clientX: 170, clientY, buttons: 0 });
  act(() => vi.advanceTimersByTime(20));
  expect(reorder).not.toHaveBeenCalled();
});

test.each(['ltr', 'rtl'])(
  'column hit-testing stays stable across rapid reversals and distant pointer positions in %s',
  (direction) => {
    vi.useFakeTimers();
    const { container, name, size } = columnHeaders(direction);
    // Simulate stale/animated child bounds far from their actual grid slots.
    vi.mocked(name.getBoundingClientRect).mockReturnValue(new DOMRect(900, 0, 100, 400));
    vi.mocked(size.getBoundingClientRect).mockReturnValue(new DOMRect(-900, 0, 100, 400));
    const reorder = vi.fn();
    const { result, rerender } = renderHook(
      ({ order }) => useColumnDragReorder({ order, onReorder: reorder }),
      { initialProps: { order: ['name', 'size'] } },
    );
    result.current.registerHeaderRef('name')(name);
    result.current.registerHeaderRef('size')(size);
    act(() => result.current.refreshRects());
    act(() => result.current.getDragHandleProps('name').onMouseDown(down(name, 250)));
    for (let i = 0; i < 12; i++) {
      const forward = i % 2 === 0;
      const right = forward !== (direction === 'rtl');
      const clientX =
        i < 6
          ? right
            ? 2000
            : -2000
          : direction === 'rtl'
            ? right
              ? 270
              : 130
            : right
              ? 170
              : 30;
      fireEvent.mouseMove(document, { clientX, clientY: i % 2 ? -500 : 1000, buttons: 1 });
      act(() => vi.advanceTimersByTime(20));
      const order = forward ? ['size', 'name'] : ['name', 'size'];
      expect(reorder).toHaveBeenCalledTimes(i + 1);
      expect(reorder).toHaveBeenLastCalledWith(order);
      container.append(...(forward ? [size, name] : [name, size]));
      rerender({ order });
    }
    fireEvent.mouseUp(document);
  },
);

test.each(['ltr', 'rtl'])(
  'data cells animate with their headers and stay scoped to their own table in %s',
  (direction) => {
    vi.useFakeTimers();
    const { container, name, size } = columnHeaders(direction);
    const scope = document.createElement('section');
    scope.dataset.columnReorderScope = '';
    document.body.append(scope);
    scope.append(container);
    const cell = document.createElement('span');
    cell.dataset.columnCell = 'size';
    scope.append(cell);
    const otherCell = document.createElement('span');
    otherCell.dataset.columnCell = 'size';
    document.body.append(otherCell);
    const { result, rerender, unmount } = renderHook(
      ({ order }) => useColumnDragReorder({ order }),
      { initialProps: { order: ['name', 'size'] } },
    );
    result.current.registerHeaderRef('name')(name);
    result.current.registerHeaderRef('size')(size);
    act(() => result.current.refreshRects());
    for (let i = 0; i < 4; i++) {
      const forward = i % 2 === 0;
      container.append(...(forward ? [size, name] : [name, size]));
      rerender({ order: forward ? ['size', 'name'] : ['name', 'size'] });
      const dx = (forward ? 100 : -100) * (direction === 'rtl' ? -1 : 1);
      expect(size.style.transform).toBe(`translateX(${dx}px)`);
      expect(cell.style.transform).toBe(size.style.transform);
      expect(otherCell.style.transform).toBe('');
      act(() => vi.advanceTimersByTime(20));
      expect(cell.style.transform).toBe('');
      expect(cell.style.transition).toBe(size.style.transition);
      expect(cell.style.transition).toBe('transform 150ms ease');
    }
    unmount();
    expect(cell.style.transition).toBe('');
    expect(size.style.transition).toBe('');
  },
);

test.each(['ltr', 'rtl'])(
  'file drag hits the logical name cell and offsets the ghost in %s',
  (direction) => {
    document.documentElement.dir = direction;
    const list = element(direction);
    list.className = 'pane-list';
    list.dataset.side = 'b';
    const row = element(direction);
    row.className = 'row is-dir';
    row.dataset.name = 'folder';
    row.style.setProperty('--name-cell-width', '100');
    list.append(row);
    const ghost = element(direction);
    const onDrop = vi.fn();
    const { result } = renderHook(() => useDragMove(onDrop));
    result.current.ghostRef.current = ghost;
    act(() =>
      result.current.startDrag('a', ['file'], { name: 'file', isDirectory: false }, down(row, 50)),
    );
    const clientX = direction === 'rtl' ? 450 : 150;
    fireEvent.mouseMove(row, { clientX, clientY: 100, buttons: 1 });
    expect(ghost.style.transform).toContain(
      `translate(${direction === 'rtl' ? -14 : 14}px, -12px)`,
    );
    fireEvent.mouseUp(row, { clientX, clientY: 100 });
    expect(onDrop).toHaveBeenCalledWith({
      sourceSide: 'a',
      names: ['file'],
      targetSide: 'b',
      targetFolder: 'folder',
      isMove: false,
    });
    expect(result.current.dragInfo).toBeNull();
  },
);
