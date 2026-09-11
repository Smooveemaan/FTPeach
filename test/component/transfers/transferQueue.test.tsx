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
