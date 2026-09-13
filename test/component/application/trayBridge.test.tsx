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
  const updateTransfers = vi.fn();
  const persist = vi.fn();
  const connectSavedSite = vi.fn();
  const sites = [
    { id: 'prod', name: 'Production' },
    { id: 'stage', name: 'Staging' },
  ];
  const quit = { pending: false, promptOpen: false, request: vi.fn(), cancel: vi.fn() };
  const baseProps: TrayBridgeOptions = {
    t,
    transfers: idle,
    pauseAllTransfers,
    resumeAllTransfers,
    quit,
    settings: {
      transferSpeedLimitKBps: 0,
      preventSleepDuringTransfers: true,
      notifyOnTransferComplete: true,
    },
    updateTransfers,
    recentSites: sites,
    connectableSites: sites,
    connectSavedSite,
    freeConnectTargetPaneId: 'a',
    trayApi,
    vaultApi,
    persist,
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
    quit,
    updateTransfers,
    persist,
    connectSavedSite,
    sites,
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

test('the status line gains the speed once it is measured and shows 0 when progress stops', async () => {
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
  act(() => setTransfersStore({ upload: running(300) }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  act(() => setTransfersStore({ upload: running(500) }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(view.lastModel()?.status).toBe(
    'tray.transferringProgress{"count":1,"percent":50} · common.perSecond{"value":"200 common.units.byte"}',
  );

  // Nothing arrives any more, yet the tray looks again on its own.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(view.lastModel()?.status).toBe(
    'tray.transferringProgress{"count":1,"percent":50} · common.perSecond{"value":"0 common.units.byte"}',
  );
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

test('quit requests and cancellations reach the quit model, and its state reaches the tray', async () => {
  const view = setup({ configured: false, locked: true });
  await act(async () => {
    await Promise.resolve();
  });
  view.fire({ kind: 'quitRequested' });
  expect(view.quit.request).toHaveBeenCalledOnce();
  view.fire({ kind: 'cancelQuit' });
  expect(view.quit.cancel).toHaveBeenCalledOnce();

  const calls = view.trayApi.setModel.mock.calls.length;
  view.rerender({ ...view.baseProps, quit: { ...view.quit, promptOpen: true } });
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(calls + 1);
  expect(view.lastModel()?.quitPromptOpen).toBe(true);
  view.rerender({ ...view.baseProps, quit: { ...view.quit, pending: true } });
  expect(view.lastModel()?.quitPending).toBe(true);
  expect(view.lastModel()?.quitPromptOpen).toBe(false);
});

test('unmounting stops listening for tray actions', () => {
  const view = setup();
  view.unmount();
  view.fire({ kind: 'pauseAll' });
  expect(view.pauseAllTransfers).not.toHaveBeenCalled();
});

test('settings changed from the tray update the state and the store together', async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  view.fire({ kind: 'setSpeedLimit', kbps: 5120 });
  expect(view.updateTransfers).toHaveBeenLastCalledWith({ transferSpeedLimitKBps: 5120 });
  expect(view.persist).toHaveBeenLastCalledWith({ transferSpeedLimitKBps: 5120 });
  view.fire({ kind: 'setPreventSleep', enabled: false });
  expect(view.persist).toHaveBeenLastCalledWith({ preventSleepDuringTransfers: false });
  view.fire({ kind: 'setNotifyOnComplete', enabled: false });
  expect(view.updateTransfers).toHaveBeenLastCalledWith({ notifyOnTransferComplete: false });

  const calls = view.trayApi.setModel.mock.calls.length;
  view.rerender({
    ...view.baseProps,
    settings: { ...view.baseProps.settings, transferSpeedLimitKBps: 5120 },
  });
  expect(view.trayApi.setModel).toHaveBeenCalledTimes(calls + 1);
  expect(view.lastModel()?.speedLimitKBps).toBe(5120);
});

test('connect opens a site that still exists in the free pane and ignores a deleted one', async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.lastModel()?.recentSites).toEqual([
    { id: 'prod', label: 'Production' },
    { id: 'stage', label: 'Staging' },
  ]);
  view.fire({ kind: 'connect', siteId: 'stage' });
  expect(view.connectSavedSite).toHaveBeenCalledWith(view.sites[1], 'a');

  view.rerender({ ...view.baseProps, freeConnectTargetPaneId: null });
  view.fire({ kind: 'connect', siteId: 'prod' });
  expect(view.connectSavedSite).toHaveBeenLastCalledWith(view.sites[0], undefined);

  view.fire({ kind: 'connect', siteId: 'deleted' });
  expect(view.connectSavedSite).toHaveBeenCalledTimes(2);
});
