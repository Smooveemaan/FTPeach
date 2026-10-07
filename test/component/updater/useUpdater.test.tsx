import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { UpdaterStatus } from '../../../src/platform/ipcContracts.ts';

vi.mock('../../../src/platform/api/index.ts', () => ({
  api: { updater: { onStatus: vi.fn(), status: vi.fn(), check: vi.fn() } },
}));
import { api } from '../../../src/platform/api/index.ts';
import { useUpdater } from '../../../src/features/updater/useUpdater.ts';

test('the status snapshot is read once the listener is in place, and a live event wins', async () => {
  let listening!: (_ready: boolean) => void;
  let emit!: (_status: UpdaterStatus) => void;
  vi.mocked(api.updater.onStatus).mockImplementation((callback) => {
    emit = callback;
    return Object.assign(() => {}, {
      ready: new Promise<boolean>((done) => {
        listening = done;
      }),
    });
  });
  let answer!: (_status: UpdaterStatus) => void;
  vi.mocked(api.updater.status).mockReturnValue(
    new Promise((done) => {
      answer = done;
    }),
  );
  const { result } = renderHook(() => useUpdater(false));
  await Promise.resolve();
  expect(api.updater.status).not.toHaveBeenCalled();

  await act(async () => listening(true));
  await waitFor(() => expect(api.updater.status).toHaveBeenCalled());
  act(() => emit({ state: 'downloaded', version: '2.0.0' }));
  await act(async () => answer({ state: 'available', version: '2.0.0' }));
  expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });
});

test('the daily check runs only with automatic updates on and nothing transferring', async () => {
  vi.useFakeTimers();
  vi.mocked(api.updater.onStatus).mockImplementation(() =>
    Object.assign(() => {}, { ready: new Promise<boolean>(() => {}) }),
  );
  vi.mocked(api.updater.check).mockReset();
  const day = 24 * 60 * 60 * 1000;
  const { rerender, unmount } = renderHook(({ auto, busy }) => useUpdater(auto, busy), {
    initialProps: { auto: false, busy: false },
  });
  await act(async () => vi.advanceTimersByTimeAsync(day));
  expect(api.updater.check).not.toHaveBeenCalled();

  rerender({ auto: true, busy: true });
  await act(async () => vi.advanceTimersByTimeAsync(day));
  expect(api.updater.check).not.toHaveBeenCalled();

  rerender({ auto: true, busy: false });
  await act(async () => vi.advanceTimersByTimeAsync(day - 1));
  expect(api.updater.check).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(api.updater.check).toHaveBeenCalledTimes(1);
  unmount();
  vi.useRealTimers();
});
