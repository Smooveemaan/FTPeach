import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { usePaneRefresh } from '../../../src/features/file-browser/panes/usePaneRefresh.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import {
  markConnectionDead,
  resetTransfersStoreForTests,
} from '../../../src/features/transfers/transferStore.ts';

test.each(['connecting', 'connected'] as const)(
  'reports listing failure globally only outside connection setup (%s)',
  async (status) => {
    const tab = makeTab('tab');
    tab.panes.b.kind = 'remote';
    tab.panes.b.connectionId = 'session';
    tab.panes.b.status = status;
    const failure = { ok: false, errorCode: 'invalidInput', error: 'Invalid URL', entries: [] };
    window.api = {
      session: { list: vi.fn().mockResolvedValue(failure) },
    } as unknown as Window['api'];
    const reportError = vi.fn();
    const { result } = renderHook(() =>
      usePaneRefresh({
        panes: tab.panes,
        activeTabId: tab.id,
        updatePane: vi.fn(),
        reportError,
        setErrorMessage: vi.fn(),
        defaultLocalPath: '',
      }),
    );
    await act(async () => {
      expect(await result.current.refreshPane('b', '/')).toEqual(failure);
    });
    expect(reportError).toHaveBeenCalledTimes(status === 'connecting' ? 0 : 1);
  },
);

test('a listing that lands after the user closed the session is not reported', async () => {
  resetTransfersStoreForTests();
  const tab = makeTab('tab');
  tab.panes.b.kind = 'remote';
  tab.panes.b.connectionId = 'session';
  tab.panes.b.status = 'connected';
  // What the backend answers once the session is gone: nothing is left to list.
  const failure = {
    ok: false,
    errorCode: 'connectionLost',
    error: 'No active connection',
    entries: [],
  };
  window.api = {
    session: { list: vi.fn().mockResolvedValue(failure) },
  } as unknown as Window['api'];
  const reportError = vi.fn();
  const { result } = renderHook(() =>
    usePaneRefresh({
      panes: tab.panes,
      activeTabId: tab.id,
      updatePane: vi.fn(),
      reportError,
      setErrorMessage: vi.fn(),
      defaultLocalPath: '',
    }),
  );

  await act(async () => {
    await result.current.refreshPane('b', '/');
  });
  expect(reportError).toHaveBeenCalledTimes(1);

  markConnectionDead('session');
  await act(async () => {
    await result.current.refreshPane('b', '/sub');
  });
  expect(reportError, 'the user hung up; the server did not').toHaveBeenCalledTimes(1);
  resetTransfersStoreForTests();
});
