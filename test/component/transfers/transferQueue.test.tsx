import { act, fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import TransferQueue from '../../../src/features/transfers/TransferQueue.tsx';
import {
  rememberConnectionLabels,
  resetTransfersStoreForTests,
  setTransfersStore,
} from '../../../src/features/transfers/transferStore.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

test('resizing another column preserves the rendered width of the flexible File column', () => {
  resetTransfersStoreForTests();
  setTransfersStore({
    one: {
      id: 'one',
      name: 'file',
      direction: 'up',
      status: 'done',
      protocol: 'sftp',
      connectionId: 'connection',
      localFile: 'C:/file',
      remoteTarget: '/file',
      bytes: 1,
      startedAt: 1,
    },
  });
  const onColumnWidthsChange = vi.fn();
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { container, unmount } = render(
    <TransferQueue
      onRetry={() => {}}
      onPause={() => {}}
      onStop={() => {}}
      onClearCompleted={() => {}}
      onColumnWidthsChange={onColumnWidthsChange}
    />,
  );
  try {
    const file = container.querySelector<HTMLElement>('[data-column-key="file"]')!;
    vi.spyOn(file, 'getBoundingClientRect').mockReturnValue({ width: 420 } as DOMRect);
    const handle = container.querySelector('[data-column-key="route"] .col-resize-handle')!;
    fireEvent.mouseDown(handle, { clientX: 600, button: 0 });
    fireEvent.mouseMove(document, { clientX: 570, buttons: 1 });
    expect(onColumnWidthsChange).toHaveBeenLastCalledWith({ file: 420, route: 130 });
    fireEvent.mouseMove(document, { clientX: 640, buttons: 1 });
    expect(onColumnWidthsChange).toHaveBeenLastCalledWith({ file: 420, route: 200 });
    fireEvent.mouseUp(document);
    fireEvent.doubleClick(handle);
    expect(onColumnWidthsChange.mock.lastCall?.[0].file).toBe(420);
  } finally {
    fireEvent.mouseUp(document);
    unmount();
    canvas.mockRestore();
    resetTransfersStoreForTests();
  }
});

test('stalled speed timer exists only while a transfer is in progress', () => {
  resetTransfersStoreForTests();
  const start = vi.spyOn(window, 'setInterval');
  const stop = vi.spyOn(window, 'clearInterval');
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const row: TransferRow = {
    id: 'one',
    name: 'file',
    direction: 'up',
    status: 'progress',
    protocol: 'sftp',
    connectionId: 'connection',
    localFile: 'C:\\file',
    remoteTarget: '/file',
    bytes: 0,
    startedAt: 1,
  };
  try {
    const { unmount } = render(
      <TransferQueue
        onRetry={() => {}}
        onPause={() => {}}
        onStop={() => {}}
        onClearCompleted={() => {}}
      />,
    );
    expect(start.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(0);
    act(() => setTransfersStore({ one: row }));
    const index = start.mock.calls.findIndex((call) => call[1] === 1000);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = start.mock.results[index]!.value;
    act(() => setTransfersStore({ one: { ...row, status: 'done' } }));
    expect(stop).toHaveBeenCalledWith(timer);
    unmount();
  } finally {
    start.mockRestore();
    stop.mockRestore();
    canvas.mockRestore();
    resetTransfersStoreForTests();
  }
});

test('a transfer keeps naming its server after that connection closes', () => {
  resetTransfersStoreForTests();
  const row: TransferRow = {
    id: 'one',
    name: 'file',
    direction: 'up',
    status: 'done',
    protocol: 'sftp',
    connectionId: 'connection',
    localFile: 'C:/file',
    remoteTarget: '/file',
    bytes: 1,
    startedAt: 1,
  };
  setTransfersStore({ one: row });
  const queue = (connectionLabels: ReadonlyMap<string, string>) => (
    <TransferQueue
      onRetry={() => {}}
      onPause={() => {}}
      onStop={() => {}}
      onClearCompleted={() => {}}
      connectionLabels={connectionLabels}
    />
  );
  try {
    const open = new Map([['connection', 'Production']]);
    rememberConnectionLabels(open);
    const { container, rerender } = render(queue(open));
    const cell = () => container.querySelector('.t-route')?.getAttribute('aria-label');
    const route = '⁨C:\\⁩ → ⁨Production⁩';
    expect(cell()).toBe(route);
    rerender(queue(new Map()));
    expect(cell()).toBe(route);
  } finally {
    resetTransfersStoreForTests();
  }
});

function queueRow(
  id: string,
  startedAt: number,
  status: TransferRow['status'] = 'queued',
): TransferRow {
  return {
    id,
    name: id,
    startedAt,
    status,
    direction: 'up',
    protocol: 'sftp',
    connectionId: id,
    localFile: id,
    remoteTarget: '/' + id,
    bytes: startedAt,
    total: 100 + startedAt,
  };
}

const queueProps = {
  onRetry: () => {},
  onPause: () => {},
  onStop: () => {},
  onClearCompleted: () => {},
};
const names = (container: HTMLElement) =>
  [...container.querySelectorAll('.t-name')].map((el) => el.textContent);

test('queue order puts running rows first, newest within each status, and completed rows last', () => {
  resetTransfersStoreForTests();
  const old = queueRow('old', 1, 'progress'),
    newer = queueRow('new', 2),
    done = queueRow('done', 3, 'done');
  setTransfersStore({ old, newer, done });
  const { container, unmount } = render(<TransferQueue {...queueProps} />);
  try {
    expect(names(container)).toEqual(['old', 'new', 'done']);
    act(() => setTransfersStore({ old, newer, done, latest: queueRow('latest', 4) }));
    expect(names(container)).toEqual(['old', 'latest', 'new', 'done']);
    act(() =>
      setTransfersStore({
        old,
        newer: { ...newer, status: 'done' },
        done,
        latest: queueRow('latest', 4),
      }),
    );
    expect(names(container)).toEqual(['old', 'latest', 'done', 'new']);
    act(() =>
      setTransfersStore({
        old: { ...old, status: 'done' },
        latest: queueRow('latest', 4, 'progress'),
        running: queueRow('running', 5, 'progress'),
        queued: queueRow('queued', 20),
        paused: queueRow('paused', 21, 'paused'),
        error: queueRow('error', 22, 'error'),
        stopped: queueRow('stopped', 23, 'stopped'),
        cancelling: queueRow('cancelling', 24, 'cancelling'),
        done,
      }),
    );
    expect(names(container)).toEqual([
      'running',
      'latest',
      'cancelling',
      'queued',
      'paused',
      'error',
      'stopped',
      'done',
      'old',
    ]);
    expect(container.querySelector('.transfer-new-items')).toBeNull();
  } finally {
    unmount();
    resetTransfersStoreForTests();
  }
});

test('all data headers sort in both directions and the third click restores queue order', () => {
  resetTransfersStoreForTests();
  setTransfersStore({ a: queueRow('file10', 10, 'done'), b: queueRow('file2', 2, 'paused') });
  const { container, unmount } = render(
    <TransferQueue {...queueProps} onColumnWidthsChange={() => {}} />,
  );
  try {
    expect(
      [...container.querySelectorAll('[data-column-key]')]
        .map((el) => el.getAttribute('data-column-key'))
        .slice(0, 2),
    ).toEqual(['route', 'file']);
    for (const key of ['file', 'route', 'size', 'transferred', 'progress', 'speed', 'remaining']) {
      const header = container.querySelector('[data-column-key="' + key + '"]')!;
      fireEvent.click(header);
      expect(header.getAttribute('aria-pressed')).toBe('true');
      if (!['speed', 'remaining'].includes(key))
        expect(names(container)).toEqual(['file2', 'file10']);
      fireEvent.click(header);
      if (!['speed', 'remaining'].includes(key))
        expect(names(container)).toEqual(['file10', 'file2']);
      fireEvent.click(header);
      expect(header.getAttribute('aria-pressed')).toBe('false');
      expect(names(container)).toEqual(['file2', 'file10']);
    }
    const file = container.querySelector('[data-column-key="file"]')!;
    fireEvent.keyDown(file, { key: 'Enter' });
    expect(file.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(file.querySelector('.col-resize-handle')!);
    expect(file.querySelector('.sort-indicator.desc')).toBeNull();
  } finally {
    unmount();
    resetTransfersStoreForTests();
  }
});

test('header context menu hides and restores File in headers and rows', () => {
  resetTransfersStoreForTests();
  setTransfersStore({ one: queueRow('one', 1) });
  const changed = vi.fn();
  const { container, unmount } = render(
    <TransferQueue {...queueProps} onHiddenColumnsChange={changed} />,
  );
  try {
    const open = () =>
      fireEvent.contextMenu(container.querySelector('.transfer-col-header')!, {
        clientX: 20,
        clientY: 20,
      });
    const fileOption = () =>
      [...document.querySelectorAll('.context-menu button')].find(
        (el) => el.querySelector('.menu-item-label')?.textContent === 'File',
      )!;
    open();
    fireEvent.click(fileOption());
    expect(changed).toHaveBeenLastCalledWith(['file']);
    expect(container.querySelector('[data-column-key="file"]')).toBeNull();
    expect(container.querySelector('.t-file')).toBeNull();
    open();
    fireEvent.click(fileOption());
    expect(changed).toHaveBeenLastCalledWith([]);
    expect(container.querySelector('[data-column-key="file"]')).not.toBeNull();
    expect(container.querySelector('.t-file')).not.toBeNull();
  } finally {
    unmount();
    resetTransfersStoreForTests();
  }
});

test('reset widths fit labels and status pills while restoring flexible File', () => {
  resetTransfersStoreForTests();
  setTransfersStore({ one: queueRow('one', 1) });
  const measureText = vi.fn(() => ({ width: 240 }) as TextMetrics);
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ measureText } as unknown as CanvasRenderingContext2D);
  const changed = vi.fn();
  const view = render(
    <TransferQueue
      {...queueProps}
      columnWidths={{ file: 400, route: 180 }}
      onColumnWidthsChange={changed}
    />,
  );
  try {
    const grid = () =>
      view.container.querySelector<HTMLElement>('.transfer-col-header')!.style.gridTemplateColumns;
    expect(grid()).toContain('180px 400px');
    view.rerender(
      <TransferQueue {...queueProps} columnWidths={{}} onColumnWidthsChange={changed} />,
    );
    expect(grid()).toContain('253px minmax(253px, 1fr)');
    expect(
      view.container.querySelector<HTMLElement>('.transfer-item')!.style.gridTemplateColumns,
    ).toBe(grid());
    expect(changed).not.toHaveBeenCalled();
    expect(measureText).toHaveBeenCalled();
    const savedWidths = { file: 400, route: 180, transferred: 80 };
    view.rerender(
      <TransferQueue {...queueProps} columnWidths={savedWidths} onColumnWidthsChange={changed} />,
    );
    const click = (key: string) =>
      fireEvent.click(view.container.querySelector('[data-column-key="' + key + '"]')!);
    click('transferred');
    expect(changed).toHaveBeenLastCalledWith({ ...savedWidths, transferred: 253 });
    view.rerender(
      <TransferQueue
        {...queueProps}
        columnWidths={{ ...savedWidths, transferred: 253 }}
        onColumnWidthsChange={changed}
      />,
    );
    click('route');
    expect(changed).toHaveBeenLastCalledWith({ ...savedWidths, route: 253 });
    // Resizing the auto-widened column manually must survive changing the sort.
    view.rerender(
      <TransferQueue
        {...queueProps}
        columnWidths={{ ...savedWidths, route: 300 }}
        onColumnWidthsChange={changed}
      />,
    );
    changed.mockClear();
    click('file');
    expect(changed).not.toHaveBeenCalled();
    click('transferred');
    expect(changed).toHaveBeenLastCalledWith({ ...savedWidths, route: 300, transferred: 253 });
    view.rerender(
      <TransferQueue
        {...queueProps}
        columnWidths={{ ...savedWidths, route: 300, transferred: 253 }}
        onColumnWidthsChange={changed}
      />,
    );
    click('transferred');
    click('transferred');
    expect(changed).toHaveBeenLastCalledWith({ ...savedWidths, route: 300 });
  } finally {
    view.unmount();
    canvas.mockRestore();
    resetTransfersStoreForTests();
  }
});

test('direction arrow is pinned before Route and File, while Status stays sortable', () => {
  resetTransfersStoreForTests();
  setTransfersStore({ one: queueRow('one', 1, 'progress') });
  const view = render(
    <TransferQueue
      {...queueProps}
      onColumnOrderChange={() => {}}
      onColumnWidthsChange={() => {}}
    />,
  );
  try {
    const header = view.container.querySelector('.transfer-col-header')!;
    const first = header.firstElementChild!;
    expect(first.className).toBe('col-direction');
    expect(first.getAttribute('role')).toBeNull();
    expect(first.getAttribute('data-reorderable')).toBeNull();
    expect(first.querySelector('.col-resize-handle')).toBeNull();
    const row = view.container.querySelector('.transfer-item')!;
    expect(row.firstElementChild?.className).toBe('t-direction');
    expect(row.firstElementChild?.querySelector('.dir-icon.dir-up')).not.toBeNull();
    expect(row.querySelector('.t-file .dir-icon')).toBeNull();
    expect(header.querySelector('[data-column-key="status"]')?.getAttribute('role')).toBe('button');
    expect(row.querySelector('.status-tag')?.textContent).toBe('Upload');
  } finally {
    view.unmount();
    resetTransfersStoreForTests();
  }
});
