import { act, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import TransferQueue from '../../../src/features/transfers/TransferQueue.tsx';
import {
  resetTransfersStoreForTests,
  setTransfersStore,
} from '../../../src/features/transfers/transferStore.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

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
