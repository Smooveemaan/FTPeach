import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../../src/platform/api/index.ts', () => ({
  api: { transfer: { onDragOutStarted: vi.fn(), onProgress: vi.fn() } },
}));
import { api } from '../../../src/platform/api/index.ts';
import type {
  DragOutTransferStarted,
  TransferProgress,
} from '../../../src/platform/ipcContracts.ts';
import { useTransferProgressAdapter } from '../../../src/features/transfers/useTransferProgressAdapter.ts';
import {
  getTransfersSnapshot,
  resetTransfersStoreForTests,
} from '../../../src/features/transfers/transferStore.ts';

afterEach(() => {
  vi.restoreAllMocks();
  resetTransfersStoreForTests();
});

test('an empty dragged folder appears and completes without any file content events', () => {
  let started!: (_payload: DragOutTransferStarted) => void;
  let progress!: (_payload: TransferProgress) => void;
  vi.spyOn(api.transfer, 'onDragOutStarted').mockImplementation((callback) => {
    started = callback;
    return () => {};
  });
  vi.spyOn(api.transfer, 'onProgress').mockImplementation((callback) => {
    progress = callback;
    return () => {};
  });
  renderHook(() => useTransferProgressAdapter({ current: {} }));
  const payload: DragOutTransferStarted = {
    id: 'empty-folder',
    connectionId: 'session',
    protocol: 'sftp',
    name: 'Empty',
    remoteFile: '/parent/Empty',
    isDirectory: true,
  };
  act(() => started(payload));
  expect(getTransfersSnapshot()['empty-folder']).toMatchObject({
    direction: 'down',
    dragOut: true,
    isDirectory: true,
    status: 'progress',
    name: 'Empty',
  });
  act(() => progress({ id: payload.id, connectionId: 'session', status: 'done', bytes: 0 }));
  expect(getTransfersSnapshot()['empty-folder']?.status).toBe('done');
});
