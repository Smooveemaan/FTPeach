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
