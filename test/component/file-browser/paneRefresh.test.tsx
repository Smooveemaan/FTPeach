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

test('a successful late reply cannot repopulate a closed remote pane', async () => {
  resetTransfersStoreForTests();
  const tab = makeTab('late');
  tab.panes.b.kind = 'remote';
  tab.panes.b.connectionId = 'late-session';
  tab.panes.b.status = 'connected';
  let resolve!: (_value: unknown) => void;
  window.api = {
    session: {
      list: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  } as unknown as Window['api'];
  const updatePane = vi.fn();
  const { result, unmount } = renderHook(() =>
    usePaneRefresh({
      panes: tab.panes,
      activeTabId: tab.id,
      updatePane,
      reportError: vi.fn(),
      setErrorMessage: vi.fn(),
      defaultLocalPath: '',
    }),
  );
  let pending!: ReturnType<typeof result.current.refreshPane>;
  await act(async () => {
    pending = result.current.refreshPane('b', '/');
  });
  markConnectionDead('late-session');
  await act(async () => {
    resolve({ ok: true, entries: [{ name: 'stale' }] });
    await pending;
  });
  expect(updatePane.mock.calls.some(([, patch]) => 'entries' in patch)).toBe(false);
  unmount();
  resetTransfersStoreForTests();
});

test('local navigation and unmount abort obsolete listings without publishing their data', async () => {
  const tab = makeTab('local');
  const requests: Array<{ signal: AbortSignal; resolve: (_value: unknown) => void }> = [];
  window.api = {
    fsLocal: {
      list: (_path: string, _key: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          requests.push({ signal, resolve });
        }),
    },
  } as unknown as Window['api'];
  const updatePane = vi.fn();
  const { result, unmount } = renderHook(() =>
    usePaneRefresh({
      panes: tab.panes,
      activeTabId: tab.id,
      updatePane,
      reportError: vi.fn(),
      setErrorMessage: vi.fn(),
      defaultLocalPath: '',
    }),
  );
  let first!: ReturnType<typeof result.current.refreshPane>;
  let second!: ReturnType<typeof result.current.refreshPane>;
  await act(async () => {
    first = result.current.refreshPane('a', 'C:\\first');
  });
  await act(async () => {
    second = result.current.refreshPane('a', 'C:\\second');
  });
  expect(requests[0]!.signal.aborted).toBe(true);
  await act(async () => {
    requests[1]!.resolve({ ok: true, path: 'C:\\second', entries: [] });
    await second;
    requests[0]!.resolve({ ok: true, path: 'C:\\first', entries: [{ name: 'stale' }] });
    await first;
  });
  expect(
    updatePane.mock.calls.filter(([, patch]) => 'entries' in patch).map(([, patch]) => patch.path),
  ).toEqual(['C:\\second']);
  let last!: ReturnType<typeof result.current.refreshPane>;
  await act(async () => {
    last = result.current.refreshPane('a', 'C:\\last');
  });
  unmount();
  expect(requests[2]!.signal.aborted).toBe(true);
  requests[2]!.resolve({ ok: true, entries: [] });
  await last;
});

test('switching a pane back to local keeps the listing it just started', async () => {
  const remoteTab = makeTab('switch');
  remoteTab.panes.a.kind = 'remote';
  remoteTab.panes.a.status = 'idle';
  const requests: Array<{ signal: AbortSignal; resolve: (_value: unknown) => void }> = [];
  window.api = {
    fsLocal: {
      list: (_path: string, _key: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          requests.push({ signal, resolve });
        }),
    },
  } as unknown as Window['api'];
  const updatePane = vi.fn();
  const { result, rerender, unmount } = renderHook(
    ({ panes }) =>
      usePaneRefresh({
        panes,
        activeTabId: remoteTab.id,
        updatePane,
        reportError: vi.fn(),
        setErrorMessage: vi.fn(),
        defaultLocalPath: '',
      }),
    { initialProps: { panes: remoteTab.panes } },
  );
  const localPanes = { ...remoteTab.panes, a: { ...remoteTab.panes.a, kind: 'local' as const } };
  let pending!: ReturnType<typeof result.current.refreshPane>;
  // Like switchPaneToLocal: the listing starts before the new kind is rendered.
  await act(async () => {
    pending = result.current.refreshPane('a', '', localPanes.a);
  });
  rerender({ panes: localPanes });
  expect(requests[0]!.signal.aborted).toBe(false);
  await act(async () => {
    requests[0]!.resolve({ ok: true, path: 'C:/root', entries: [] });
    await pending;
  });
  expect(updatePane).toHaveBeenLastCalledWith(
    'a',
    expect.objectContaining({ loading: false, path: 'C:/root' }),
    remoteTab.id,
  );
  unmount();
});

test('switching a pane away from local aborts its listing and clears the spinner', async () => {
  const tab = makeTab('away');
  const requests: Array<{ signal: AbortSignal; resolve: (_value: unknown) => void }> = [];
  window.api = {
    fsLocal: {
      list: (_path: string, _key: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          requests.push({ signal, resolve });
        }),
    },
  } as unknown as Window['api'];
  const updatePane = vi.fn();
  const { result, rerender, unmount } = renderHook(
    ({ panes }) =>
      usePaneRefresh({
        panes,
        activeTabId: tab.id,
        updatePane,
        reportError: vi.fn(),
        setErrorMessage: vi.fn(),
        defaultLocalPath: '',
      }),
    { initialProps: { panes: tab.panes } },
  );
  let pending!: ReturnType<typeof result.current.refreshPane>;
  await act(async () => {
    pending = result.current.refreshPane('a', 'C:/root');
  });
  rerender({ panes: { ...tab.panes, a: { ...tab.panes.a, kind: 'remote' as const } } });
  expect(requests[0]!.signal.aborted).toBe(true);
  await act(async () => {
    requests[0]!.resolve({ ok: true, path: 'C:/root', entries: [{ name: 'stale' }] });
    await pending;
  });
  expect(updatePane.mock.calls.some(([, patch]) => 'entries' in patch)).toBe(false);
  expect(updatePane).toHaveBeenLastCalledWith('a', { loading: false }, tab.id);
  unmount();
});
