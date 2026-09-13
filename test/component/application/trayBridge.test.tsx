import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useTrayBridge } from '../../../src/app/tray/useTrayBridge.ts';
import type { TrayBridgeOptions } from '../../../src/app/tray/useTrayBridge.ts';
import {
  resetTransfersStoreForTests,
  setTransfersStore,
} from '../../../src/features/transfers/transferStore.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';
import type { TrayAction, TrayModel } from '../../../src/platform/api/tray.ts';
import type { Translate } from '../../../src/shared/types.ts';

vi.mock('../../../src/platform/api/index.ts', () => ({ api: {} }));

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as Translate;

const idle = { activeTransfersCount: 0, hasPausableTransfers: false, canResumeAllTransfers: false };

function setup(vaultStatus = { configured: true, locked: false }) {
  let onAction: ((_action: TrayAction) => void) | undefined;
  const trayApi = {
    setModel: vi.fn(async (_model: TrayModel) => ({ ok: true })),
    onAction: vi.fn((callback: (_action: TrayAction) => void) => {
      onAction = callback;
      return () => {
        onAction = undefined;
      };
    }),
  };
  const status = { ...vaultStatus };
  const vaultApi = {
    status: vi.fn(async () => ({
      ...status,
      systemUnlockAvailable: false,
      systemUnlockEnabled: false,
    })),
    lock: vi.fn(async () => {
      status.locked = true;
      return { ok: true };
    }),
  };
  const pauseAllTransfers = vi.fn();
  const resumeAllTransfers = vi.fn();
  const baseProps: TrayBridgeOptions = {
    t,
    transfers: idle,
    pauseAllTransfers,
    resumeAllTransfers,
    trayApi,
    vaultApi,
  };
  const view = renderHook((props: TrayBridgeOptions) => useTrayBridge(props), {
    initialProps: baseProps,
  });
  return {
    ...view,
    baseProps,
    trayApi,
    vaultApi,
    pauseAllTransfers,
    resumeAllTransfers,
    lastModel: () => trayApi.setModel.mock.calls.at(-1)?.[0],
    fire: (action: TrayAction) => act(() => onAction?.(action)),
  };
}

function running(bytes: number): TransferRow {
  return {
    id: 'upload',
    name: 'file.bin',
    direction: 'up',
    protocol: 'sftp',
    status: 'progress',
    bytes,
    total: 1000,
    startedAt: 0,
    connectionId: 'c1',
    localFile: 'C:\\file.bin',
    remoteTarget: '/file.bin',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTransfersStoreForTests();
});

afterEach(() => {
  resetTransfersStoreForTests();
  vi.useRealTimers();
});

test('the model goes out on mount and again once the vault turns out to be lockable', async () => {
  const view = setup();
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(1);
  expect(view.lastModel()?.vaultLockable).toBe(false);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(2);
  expect(view.lastModel()?.vaultLockable).toBe(true);
});

test('a changed summary is sent at once, an unchanged render is not sent again', async () => {
  const view = setup({ configured: false, locked: true });
  await act(async () => {
    await Promise.resolve();
  });
  const calls = view.trayApi.setModel.mock.calls.length;
  view.rerender({ ...view.baseProps });
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(calls);

  act(() => setTransfersStore({ upload: running(100) }));
  view.rerender({
    ...view.baseProps,
    transfers: {
      activeTransfersCount: 1,
      hasPausableTransfers: true,
      canResumeAllTransfers: false,
    },
  });
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(calls + 1);
  expect(view.lastModel()?.status).toBe('tray.transferringProgress{"count":1,"percent":10}');
  expect(view.lastModel()?.transfers).toEqual({
    active: 1,
    canPauseAll: true,
    canResumeAll: false,
  });
});

test('progress alone reaches the tray at most once a second', async () => {
  const view = setup({ configured: false, locked: true });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => setTransfersStore({ upload: running(100) }));
  view.rerender({
    ...view.baseProps,
    transfers: {
      activeTransfersCount: 1,
      hasPausableTransfers: true,
      canResumeAllTransfers: false,
    },
  });
  const calls = view.trayApi.setModel.mock.calls.length;

  act(() => setTransfersStore({ upload: running(200) }));
  act(() => setTransfersStore({ upload: running(300) }));
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(calls);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(calls + 1);
  expect(view.lastModel()?.status).toBe('tray.transferringProgress{"count":1,"percent":30}');
});

test('tray actions call the same functions as the window', async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  view.fire({ kind: 'pauseAll' });
  expect(view.pauseAllTransfers).toHaveBeenCalledOnce();
  view.fire({ kind: 'resumeAll' });
  expect(view.resumeAllTransfers).toHaveBeenCalledOnce();

  const locked = vi.fn();
  window.addEventListener('ftpeach:vault-locked', locked);
  try {
    view.fire({ kind: 'lockVault' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.vaultApi.lock).toHaveBeenCalledOnce();
    expect(locked).toHaveBeenCalledOnce();
    expect(view.lastModel()?.vaultLockable).toBe(false);
  } finally {
    window.removeEventListener('ftpeach:vault-locked', locked);
  }
});

test('unmounting stops listening for tray actions', () => {
  const view = setup();
  view.unmount();
  view.fire({ kind: 'pauseAll' });
  expect(view.pauseAllTransfers).not.toHaveBeenCalled();
});
