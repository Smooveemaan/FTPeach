import { readyUnsubscribe } from '../../../src/platform/ipcContracts.ts';
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useFileClipboard } from '../../../src/features/file-browser/useFileClipboard.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { usePaneRefresh } from '../../../src/features/file-browser/panes/usePaneRefresh.ts';
import { useDragMove } from '../../../src/features/file-browser/components/useDragMove.ts';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';
import type { TransferBatchResult } from '../../../src/features/transfers/transferBatchResult.ts';

vi.mock('../../../src/features/file-browser/components/useDragMove.ts', () => ({
  useDragMove: vi.fn(() => ({
    cancelDrag: vi.fn(),
    beginNativeDrag: vi.fn(),
    nativeMotion: vi.fn(),
    ghostRef: { current: null },
    dragInfo: null,
  })),
}));

const onMotion = vi.fn(() => readyUnsubscribe(() => {}));
function createDirectoryWatcher() {
  const listeners = new Set<(_path: string) => void>();
  const unsubscribe = vi.fn();
  return {
    watchDirectories: vi.fn(async (_paths: string[]) => ({ ok: true })),
    onDirectoryChanged: vi.fn((callback: (_path: string) => void) => {
      listeners.add(callback);
      return readyUnsubscribe(() => {
        listeners.delete(callback);
        unsubscribe();
      });
    }),
    emit: (path: string) => listeners.forEach((callback) => callback(path)),
    unsubscribe,
  };
}

let directoryWatcher: ReturnType<typeof createDirectoryWatcher>;
beforeEach(() => {
  directoryWatcher = createDirectoryWatcher();
  window.api = {
    dragOut: { onMotion },
    fsLocal: directoryWatcher,
  } as unknown as Window['api'];
});

test.each(['Linux', 'Windows NT 10.0', 'Macintosh'])(
  'window focus refreshes only populated local panes on Linux (%s)',
  async (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
    const tab = makeTab('tab');
    tab.panes.a.path = '/work';
    tab.panes.b.path = '/remote';
    const refreshPaneIfAt = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(() =>
      useFileClipboard({
        browser: { panes: tab.panes, canCopyBetween: vi.fn(), refreshPaneIfAt },
        transfers: { copyEntries: vi.fn() },
      }),
    );
    expect(refreshPaneIfAt).not.toHaveBeenCalled();
    if (platform !== 'Linux') {
      expect(directoryWatcher.onDirectoryChanged).not.toHaveBeenCalled();
      expect(directoryWatcher.watchDirectories).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(refreshPaneIfAt).toHaveBeenCalledWith('a', '/work'));
    }
    refreshPaneIfAt.mockClear();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(refreshPaneIfAt.mock.calls).toEqual(platform === 'Linux' ? [['a', '/work']] : []);

    tab.panes.a = { ...tab.panes.a, path: '' };
    tab.panes.b = { ...tab.panes.b, kind: 'local', path: '/destination' };
    rerender();
    if (platform === 'Linux') {
      await waitFor(() => expect(refreshPaneIfAt).toHaveBeenCalledWith('b', '/destination'));
    }
    refreshPaneIfAt.mockClear();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(refreshPaneIfAt.mock.calls).toEqual(platform === 'Linux' ? [['b', '/destination']] : []);
    unmount();
    refreshPaneIfAt.mockClear();
    window.dispatchEvent(new Event('focus'));
    directoryWatcher.emit('/destination');
    expect(refreshPaneIfAt).not.toHaveBeenCalled();
    if (platform !== 'Linux') {
      expect(directoryWatcher.onDirectoryChanged).not.toHaveBeenCalled();
      expect(directoryWatcher.watchDirectories).not.toHaveBeenCalled();
    }
  },
);

test.each(['focus', 'directory event'] as const)(
  'Linux %s lists the source again when the desktop moves files after drag completion',
  async (trigger) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
    const tab = makeTab('tab');
    const file = { name: 'file.txt', isDirectory: false, size: 42 };
    Object.assign(tab.panes.a, { path: '/work', entries: [file], selected: new Set([file.name]) });
    let sourceEntries = [file];
    const list = vi.fn(async () => ({ ok: true, path: '/work', entries: sourceEntries }));
    let complete!: (_value: { ok: true }) => void;
    const startLocal = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          complete = resolve;
        }),
    );
    window.api = {
      ...window.api,
      dragOut: { onMotion, startLocal },
      fsLocal: { ...window.api.fsLocal, list },
    } as unknown as Window['api'];
    const { result } = renderHook(() => {
      const [panes, setPanes] = useState(tab.panes);
      const { refreshPaneIfAt } = usePaneRefresh({
        panes,
        activeTabId: tab.id,
        updatePane: (id, patch) =>
          setPanes((current) => ({
            ...current,
            [id]: { ...current[id], ...(typeof patch === 'function' ? patch(current[id]) : patch) },
          })),
        reportError: vi.fn(),
        defaultLocalPath: '',
      });
      useFileClipboard({
        browser: { panes, canCopyBetween: vi.fn(), refreshPaneIfAt },
        transfers: { copyEntries: vi.fn() },
      });
      return panes;
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    list.mockClear();
    act(() =>
      vi
        .mocked(useDragMove)
        .mock.calls.at(-1)?.[1]
        ?.onDragLeaveWindow?.({
          side: 'a',
          entryName: file.name,
          names: [file.name],
          isDir: false,
        }),
    );
    expect(startLocal).toHaveBeenCalledWith(['/work/file.txt']);
    expect(list).not.toHaveBeenCalled();
    await act(async () => complete({ ok: true }));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.a.entries).toEqual([file]);
    sourceEntries = [];
    await act(async () => {
      if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
      else directoryWatcher.emit('/work');
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.a.entries).toEqual([]);
    expect(result.current.a.selected.size).toBe(0);
  },
);

test.each(['current', 'stale', 'unmounted'] as const)(
  'Linux watch setup reconciles missed changes only while current (%s)',
  async (state) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
    const tab = makeTab('tab');
    const file = { name: 'moved.txt', isDirectory: false, size: 42 };
    Object.assign(tab.panes.a, { path: '/work', entries: [file], selected: new Set([file.name]) });
    let sourceEntries = [file];
    const list = vi.fn(async (path: string) => ({ ok: true, path, entries: sourceEntries }));
    let complete!: (_value: { ok: true }) => void;
    directoryWatcher.watchDirectories.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          complete = resolve;
        }),
    );
    window.api = {
      ...window.api,
      fsLocal: { ...window.api.fsLocal, list },
    } as unknown as Window['api'];
    const { result, unmount } = renderHook(() => {
      const [panes, setPanes] = useState(tab.panes);
      const { refreshPaneIfAt } = usePaneRefresh({
        panes,
        activeTabId: tab.id,
        updatePane: (id, patch) =>
          setPanes((current) => ({
            ...current,
            [id]: { ...current[id], ...(typeof patch === 'function' ? patch(current[id]) : patch) },
          })),
        reportError: vi.fn(),
        defaultLocalPath: '',
      });
      useFileClipboard({
        browser: { panes, refreshPaneIfAt, canCopyBetween: vi.fn() },
        transfers: { copyEntries: vi.fn() },
      });
      return { panes, setPanes };
    });
    await waitFor(() => expect(directoryWatcher.watchDirectories).toHaveBeenCalledWith(['/work']));
    expect(list).not.toHaveBeenCalled();
    sourceEntries = [];
    expect(result.current.panes.a.entries).toEqual([file]);

    if (state === 'stale') {
      for (const path of ['/other', '/work']) {
        await act(async () =>
          result.current.setPanes((current) => ({
            ...current,
            a: { ...current.a, path },
          })),
        );
        expect(directoryWatcher.watchDirectories).toHaveBeenLastCalledWith([path]);
      }
      // Returning to the source path must not revive the original cancelled setup.
      expect(list).toHaveBeenCalledTimes(2);
      list.mockClear();
    } else if (state === 'unmounted') {
      unmount();
      expect(directoryWatcher.watchDirectories).toHaveBeenLastCalledWith([]);
      expect(directoryWatcher.unsubscribe).toHaveBeenCalledOnce();
    }
    await act(async () => complete({ ok: true }));
    if (state === 'current') {
      expect(list).toHaveBeenCalledExactlyOnceWith(
        '/work',
        expect.any(String),
        expect.any(AbortSignal),
      );
      expect(result.current.panes.a.entries).toEqual([]);
      expect(result.current.panes.a.selected.size).toBe(0);
    } else {
      expect(list).not.toHaveBeenCalled();
    }
  },
);

test('Linux directory watches follow local paths and tabs, ignore stale events, and stop on unmount', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
  const tab = makeTab('source');
  tab.panes.a.path = '/work';
  Object.assign(tab.panes.b, { kind: 'local', path: '/destination' });
  const list = vi.fn(async (path: string) => ({ ok: true, path, entries: [] }));
  window.api = {
    ...window.api,
    fsLocal: { ...window.api.fsLocal, list },
  } as unknown as Window['api'];
  const updatePane = vi.fn();
  const { rerender, unmount } = renderHook(
    ({ panes, activeTabId }) => {
      const { refreshPaneIfAt } = usePaneRefresh({
        panes,
        activeTabId,
        updatePane,
        reportError: vi.fn(),
        defaultLocalPath: '',
      });
      return useFileClipboard({
        browser: { panes, refreshPaneIfAt, canCopyBetween: vi.fn() },
        transfers: { copyEntries: vi.fn() },
      });
    },
    { initialProps: { panes: tab.panes, activeTabId: tab.id } },
  );
  await waitFor(() =>
    expect(directoryWatcher.watchDirectories).toHaveBeenLastCalledWith(['/work', '/destination']),
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  list.mockClear();
  updatePane.mockClear();
  await act(async () => directoryWatcher.emit('/work'));
  expect(list).toHaveBeenCalledExactlyOnceWith(
    '/work',
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(updatePane.mock.calls.every(([id]) => id === 'a')).toBe(true);
  list.mockClear();
  updatePane.mockClear();
  await act(async () => directoryWatcher.emit('/destination'));
  expect(list).toHaveBeenCalledExactlyOnceWith(
    '/destination',
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(updatePane.mock.calls.every(([id]) => id === 'b')).toBe(true);

  const panes = {
    ...tab.panes,
    a: { ...tab.panes.a, path: '/other' },
    b: { ...tab.panes.b, kind: 'remote' as const },
  };
  list.mockClear();
  rerender({ panes, activeTabId: tab.id });
  await waitFor(() =>
    expect(directoryWatcher.watchDirectories).toHaveBeenLastCalledWith(['/other']),
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  list.mockClear();
  updatePane.mockClear();
  await act(async () => {
    directoryWatcher.emit('/work');
    directoryWatcher.emit('/destination');
  });
  expect(list).not.toHaveBeenCalled();
  expect(updatePane).not.toHaveBeenCalled();
  await act(async () => directoryWatcher.emit('/other'));
  expect(list).toHaveBeenCalledExactlyOnceWith(
    '/other',
    expect.any(String),
    expect.any(AbortSignal),
  );

  rerender({ panes, activeTabId: 'other-tab' });
  list.mockClear();
  updatePane.mockClear();
  await act(async () => directoryWatcher.emit('/other'));
  expect(list).toHaveBeenCalledExactlyOnceWith(
    '/other',
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(updatePane.mock.lastCall?.[2]).toBe('other-tab');
  unmount();
  expect(directoryWatcher.watchDirectories).toHaveBeenLastCalledWith([]);
  expect(directoryWatcher.unsubscribe).toHaveBeenCalledTimes(
    directoryWatcher.onDirectoryChanged.mock.calls.length,
  );
  list.mockClear();
  await act(async () => directoryWatcher.emit('/other'));
  expect(list).not.toHaveBeenCalled();
});

test.each(['path', 'tab'] as const)(
  'Linux drag completion does not restore the source after changing %s',
  async (change) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
    const tab = makeTab('source');
    Object.assign(tab.panes.a, {
      path: '/work',
      entries: [{ name: 'file.txt', isDirectory: false, size: 42 }],
    });
    let complete!: (_value: { ok: true }) => void;
    const startLocal = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          complete = resolve;
        }),
    );
    const list = vi.fn(async (path: string) => ({ ok: true, path, entries: [] }));
    window.api = {
      ...window.api,
      dragOut: { onMotion, startLocal },
      fsLocal: { ...window.api.fsLocal, list },
    } as unknown as Window['api'];
    const updatePane = vi.fn();
    const { rerender } = renderHook(
      ({ panes, activeTabId }) => {
        const { refreshPaneIfAt } = usePaneRefresh({
          panes,
          activeTabId,
          updatePane,
          reportError: vi.fn(),
          defaultLocalPath: '',
        });
        return useFileClipboard({
          browser: { panes, canCopyBetween: vi.fn(), refreshPaneIfAt },
          transfers: { copyEntries: vi.fn() },
        });
      },
      { initialProps: { panes: tab.panes, activeTabId: tab.id } },
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    list.mockClear();
    updatePane.mockClear();
    act(() =>
      vi
        .mocked(useDragMove)
        .mock.calls.at(-1)?.[1]
        ?.onDragLeaveWindow?.({
          side: 'a',
          entryName: 'file.txt',
          names: ['file.txt'],
          isDir: false,
        }),
    );
    const currentPath = change === 'path' ? '/other' : '/work';
    rerender({
      panes: { ...tab.panes, a: { ...tab.panes.a, path: currentPath } },
      activeTabId: change === 'tab' ? 'other-tab' : tab.id,
    });
    if (change === 'path') {
      await waitFor(() =>
        expect(list).toHaveBeenCalledExactlyOnceWith(
          currentPath,
          expect.any(String),
          expect.any(AbortSignal),
        ),
      );
      list.mockClear();
      updatePane.mockClear();
    }
    await act(async () => complete({ ok: true }));
    expect(list).not.toHaveBeenCalled();
    expect(updatePane).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(list).toHaveBeenCalledExactlyOnceWith(
      currentPath,
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(updatePane.mock.lastCall?.[2]).toBe(change === 'tab' ? 'other-tab' : tab.id);
  },
);

test('dragging a remote folder and file out of the window starts native drag with directory metadata', async () => {
  const tab = makeTab('tab');
  Object.assign(tab.panes.b, {
    kind: 'remote',
    connectionId: 'session',
    protocol: 'sftp',
    path: '/remote',
    entries: [
      { name: 'folder', isDirectory: true, size: 0 },
      { name: 'file.txt', isDirectory: false, size: 42 },
    ],
  });
  const start = vi.fn().mockResolvedValue({ ok: true });
  window.api = { ...window.api, dragOut: { onMotion, start } } as unknown as Window['api'];
  const { result } = renderHook(() =>
    useFileClipboard({
      browser: {
        panes: tab.panes,
        canCopyBetween: vi.fn(),
        refreshPaneIfAt: vi.fn(),
      },
      transfers: { copyEntries: vi.fn() },
    }),
  );
  await act(async () => {
    vi.mocked(useDragMove)
      .mock.calls.at(-1)?.[1]
      ?.onDragLeaveWindow?.({
        side: 'b',
        entryName: 'folder',
        names: ['folder', 'file.txt'],
        isDir: true,
      });
  });
  expect(start).toHaveBeenCalledWith('session', 'sftp', [
    { remotePath: '/remote/folder', name: 'folder', size: 0, isDirectory: true },
    { remotePath: '/remote/file.txt', name: 'file.txt', size: 42, isDirectory: false },
  ]);
  expect(result.current.outboundDragRef.current).toBe(false);
});

test('dragging local entries out of the window hands the shell their full paths', async () => {
  const tab = makeTab('tab');
  Object.assign(tab.panes.a, {
    kind: 'local',
    path: 'D:\\work',
    entries: [
      { name: 'folder', isDirectory: true, size: 0 },
      { name: 'file.txt', isDirectory: false, size: 42 },
    ],
  });
  const start = vi.fn().mockResolvedValue({ ok: true });
  const startLocal = vi.fn().mockResolvedValue({ ok: true });
  window.api = {
    ...window.api,
    dragOut: { onMotion, start, startLocal },
  } as unknown as Window['api'];
  const { result } = renderHook(() =>
    useFileClipboard({
      browser: {
        panes: tab.panes,
        canCopyBetween: vi.fn(),
        refreshPaneIfAt: vi.fn(),
      },
      transfers: { copyEntries: vi.fn() },
    }),
  );
  await act(async () => {
    vi.mocked(useDragMove)
      .mock.calls.at(-1)?.[1]
      ?.onDragLeaveWindow?.({
        side: 'a',
        entryName: 'folder',
        names: ['folder', 'file.txt'],
        isDir: true,
      });
  });
  // No session is involved, so the remote drag-out must stay out of it.
  expect(start).not.toHaveBeenCalled();
  expect(startLocal).toHaveBeenCalledWith(['D:\\work\\folder', 'D:\\work\\file.txt']);
  expect(result.current.outboundDragRef.current).toBe(false);
});

test('Ctrl-copy within a pane uses the transfer route and preserves an absolute breadcrumb target', () => {
  const tab = makeTab('tab');
  const copyEntries = vi.fn().mockResolvedValue(undefined);
  renderHook(() =>
    useFileClipboard({
      browser: {
        panes: tab.panes,
        canCopyBetween: vi.fn(() => true),
        refreshPaneIfAt: vi.fn(),
      },
      transfers: { copyEntries },
    }),
  );
  act(() =>
    vi
      .mocked(useDragMove)
      .mock.calls.at(-1)?.[0]({
        sourceSide: 'a',
        targetSide: 'a',
        targetFolder: 'C:\\parent',
        names: ['file.txt'],
        isMove: false,
      }),
  );
  expect(copyEntries).toHaveBeenCalledWith(
    expect.objectContaining({ move: false, targetFolder: 'C:\\parent' }),
  );
});

test('pasting a cut between different endpoints is refused and keeps the cut for a copy', () => {
  const tab = makeTab('tab');
  Object.assign(tab.panes.a, {
    path: 'C:\\work',
    entries: [{ name: 'file.txt', isDirectory: false, size: 1 }],
    selected: new Set(['file.txt']),
  });
  Object.assign(tab.panes.b, {
    kind: 'remote',
    status: 'connected',
    connectionId: 'session',
    protocol: 'sftp',
    path: '/remote',
  });
  const failures: unknown[] = [];
  const dispose = setAsyncFailureSink((error) => failures.push(error));
  const copyEntries = vi.fn().mockResolvedValue({ ok: false, sourceRetained: true });
  const { result } = renderHook(() =>
    useFileClipboard({
      browser: {
        panes: tab.panes,
        canCopyBetween: () => true,
        refreshPaneIfAt: vi.fn(),
      },
      transfers: { copyEntries },
    }),
  );
  act(() => result.current.cutToClipboard('a', tab.panes.a));
  act(() => result.current.pasteClipboard('b', tab.panes.b));
  expect(copyEntries).not.toHaveBeenCalled();
  expect(failures).toEqual([expect.stringMatching(/moved only within/)]);
  expect(result.current.canPaste(tab.panes.b)).toBe(true);

  act(() => result.current.pasteClipboard('a', tab.panes.a));
  expect(copyEntries).toHaveBeenCalledTimes(1);
  act(() => result.current.copyToClipboard('a', tab.panes.a));
  act(() => result.current.pasteClipboard('b', tab.panes.b));
  expect(copyEntries).toHaveBeenCalledTimes(2);
  dispose();
});

test('a cut stays on the clipboard until its files have actually moved', async () => {
  const tab = makeTab('tab');
  Object.assign(tab.panes.a, {
    kind: 'local',
    path: 'D:\\work',
    entries: [{ name: 'file.txt', isDirectory: false, size: 42 }],
    selected: new Set(['file.txt']),
  });
  let outcome: TransferBatchResult = {
    items: [{ name: 'file.txt', outcome: 'failed', sourceRetained: true }],
    copied: 0,
    moved: 0,
    skipped: 0,
    failed: 1,
    ok: false,
    sourceRetained: true,
  };
  const copyEntries = vi.fn(async () => outcome);
  const { result } = renderHook(() =>
    useFileClipboard({
      browser: {
        panes: tab.panes,
        canCopyBetween: vi.fn(() => true),
        refreshPaneIfAt: vi.fn(),
      },
      transfers: { copyEntries },
    }),
  );

  act(() => result.current.cutToClipboard('a', tab.panes.a));
  await act(async () => result.current.pasteClipboard('a', tab.panes.a));
  // The files are still where they were, so the cut is still worth pasting.
  expect(result.current.canPaste(tab.panes.a)).toBe(true);

  outcome = {
    items: [{ name: 'file.txt', outcome: 'moved', sourceRetained: false }],
    copied: 0,
    moved: 1,
    skipped: 0,
    failed: 0,
    ok: true,
    sourceRetained: false,
  };
  await act(async () => result.current.pasteClipboard('a', tab.panes.a));
  expect(result.current.canPaste(tab.panes.a)).toBe(false);
});

test('a cut marks its names in the folder it came from, and a copy marks nothing', () => {
  const tab = makeTab('tab');
  Object.assign(tab.panes.a, { kind: 'local', path: 'D:\\work', selected: new Set(['a.txt']) });
  const { result } = renderHook(() =>
    useFileClipboard({
      browser: {
        panes: tab.panes,
        canCopyBetween: vi.fn(),
        refreshPaneIfAt: vi.fn(),
      },
      transfers: { copyEntries: vi.fn() },
    }),
  );
  act(() => result.current.cutToClipboard('a', tab.panes.a));
  expect([...(result.current.cutNames(tab.panes.a) ?? [])]).toEqual(['a.txt']);
  expect(result.current.cutNames({ ...tab.panes.a, path: 'D:\\other' })).toBeUndefined();
  act(() => result.current.copyToClipboard('a', tab.panes.a));
  expect(result.current.cutNames(tab.panes.a)).toBeUndefined();
});

test.each(['local', 'remote'] as const)(
  '%s native drag keeps text selection disabled through handoff and completion',
  async (kind) => {
    const tab = makeTab('tab');
    Object.assign(tab.panes.a, {
      kind,
      path: '/work',
      connectionId: kind === 'remote' ? 'session' : null,
      entries: [{ name: 'file.txt', isDirectory: false, size: 42 }],
    });
    let complete!: (_value: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      complete = resolve;
    });
    const start = vi.fn(() => pending);
    window.api = {
      ...window.api,
      dragOut: { onMotion, start, startLocal: start },
    } as unknown as Window['api'];
    const { result } = renderHook(() =>
      useFileClipboard({
        browser: { panes: tab.panes, canCopyBetween: vi.fn(), refreshPaneIfAt: vi.fn() },
        transfers: { copyEntries: vi.fn() },
      }),
    );
    vi.mocked(result.current.dragMove.cancelDrag).mockImplementation(() => {
      expect(document.body.classList.contains('native-drag-active')).toBe(true);
      document.body.classList.remove('drag-move-active');
    });
    act(() => {
      vi.mocked(useDragMove)
        .mock.calls.at(-1)?.[1]
        ?.onDragLeaveWindow?.({
          side: 'a',
          entryName: 'file.txt',
          names: ['file.txt'],
          isDir: false,
        });
    });
    expect(start).toHaveBeenCalledOnce();
    expect(result.current.outboundDragRef.current).toBe(true);
    expect(document.body.classList.contains('native-drag-active')).toBe(true);
    await act(async () => {
      complete({ ok: true });
    });
    expect(result.current.outboundDragRef.current).toBe(false);
    expect(document.body.classList.contains('native-drag-active')).toBe(false);
  },
);
