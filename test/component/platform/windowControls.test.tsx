import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useWindowControls } from '../../../src/platform/useWindowControls.ts';
import type { NativeWindowControls } from '../../../src/platform/useWindowControls.ts';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeWindow(): NativeWindowControls {
  return {
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => vi.fn()),
    minimize: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

test('browser rendering never loads native window bindings', () => {
  const load = vi.fn();
  const { result } = renderHook(() => useWindowControls(false, load, false));
  expect(result.current.available).toBe(false);
  result.current.close();
  expect(load).not.toHaveBeenCalled();
});

test('unmount before window loading prevents a subscription', async () => {
  const pending = deferred<NativeWindowControls>();
  const win = nativeWindow();
  const { unmount } = renderHook(() => useWindowControls(false, () => pending.promise, true));
  unmount();
  await act(async () => {
    pending.resolve(win);
  });
  expect(win.onResized).not.toHaveBeenCalled();
});

test('unmount releases a subscription that completes asynchronously', async () => {
  const pending = deferred<() => void>();
  const release = vi.fn();
  const win = nativeWindow();
  win.onResized = vi.fn(() => pending.promise);
  const load = async () => win;
  const { unmount } = renderHook(() => useWindowControls(false, load, true));
  await act(async () => {});
  unmount();
  await act(async () => {
    pending.resolve(release);
  });
  expect(release).toHaveBeenCalledTimes(1);
  expect(win.isMaximized).not.toHaveBeenCalled();
});

test('out of order resize responses cannot restore stale maximized state', async () => {
  const win = nativeWindow();
  const release = vi.fn();
  let resize!: () => void;
  win.onResized = async (callback) => {
    resize = callback;
    return release;
  };
  const load = async () => win;
  const { result, unmount } = renderHook(() => useWindowControls(false, load, true));
  await act(async () => {});
  const old = deferred<boolean>();
  const next = deferred<boolean>();
  win.isMaximized = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await act(async () => {
    resize();
    resize();
    next.resolve(true);
  });
  expect(result.current.maximized).toBe(true);
  await act(async () => {
    old.resolve(false);
  });
  expect(result.current.maximized).toBe(true);
  unmount();
  expect(release).toHaveBeenCalledTimes(1);
});

test('commands honor current tray preference and report native failures', async () => {
  const win = nativeWindow();
  const load = async () => win;
  const errors = vi.fn();
  const dispose = setAsyncFailureSink(errors);
  try {
    const { result, rerender, unmount } = renderHook(
      ({ tray }) => useWindowControls(tray, load, true),
      { initialProps: { tray: false } },
    );
    await act(async () => {});
    result.current.minimize();
    expect(win.minimize).toHaveBeenCalledTimes(1);
    rerender({ tray: true });
    result.current.minimize();
    expect(win.hide).toHaveBeenCalledTimes(1);
    const failure = new Error('Native close failed');
    win.close = vi.fn().mockRejectedValue(failure);
    await act(async () => {
      result.current.close();
    });
    expect(errors).toHaveBeenCalledWith(failure);
    unmount();
    result.current.minimize();
    expect(win.hide).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
});
