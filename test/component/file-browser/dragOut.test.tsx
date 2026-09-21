import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useFileClipboard } from '../../../src/features/file-browser/useFileClipboard.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { useDragMove } from '../../../src/features/file-browser/components/useDragMove.ts';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';

vi.mock('../../../src/features/file-browser/components/useDragMove.ts', () => ({
  useDragMove: vi.fn(() => ({ cancelDrag: vi.fn(), ghostRef: { current: null }, dragInfo: null })),
}));

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
  window.api = { dragOut: { start } } as unknown as Window['api'];
  const { result } = renderHook(() =>
    useFileClipboard({
      panes: tab.panes,
      confirmOverwriteIfNeeded: vi.fn(),
      copyEntries: vi.fn(),
      canCopyBetween: vi.fn(),
      refreshPane: vi.fn(),
      movePaneSamePane: vi.fn(),
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
  window.api = { dragOut: { start, startLocal } } as unknown as Window['api'];
  const { result } = renderHook(() =>
    useFileClipboard({
      panes: tab.panes,
      confirmOverwriteIfNeeded: vi.fn(),
      copyEntries: vi.fn(),
      canCopyBetween: vi.fn(),
      refreshPane: vi.fn(),
      movePaneSamePane: vi.fn(),
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
  const movePaneSamePane = vi.fn();
  renderHook(() =>
    useFileClipboard({
      panes: tab.panes,
      copyEntries,
      movePaneSamePane,
      confirmOverwriteIfNeeded: vi.fn(async (_pane, _folder, names, proceed) => {
        proceed(names, false);
      }),
      canCopyBetween: vi.fn(() => true),
      refreshPane: vi.fn(),
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
  expect(movePaneSamePane).not.toHaveBeenCalled();
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
  const confirmOverwriteIfNeeded = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useFileClipboard({
      panes: tab.panes,
      confirmOverwriteIfNeeded,
      copyEntries: vi.fn(),
      canCopyBetween: () => true,
      refreshPane: vi.fn(),
      movePaneSamePane: vi.fn(),
    }),
  );
  act(() => result.current.cutToClipboard('a', tab.panes.a));
  act(() => result.current.pasteClipboard('b', tab.panes.b));
  expect(confirmOverwriteIfNeeded).not.toHaveBeenCalled();
  expect(failures).toEqual([expect.stringMatching(/moved only within/)]);
  expect(result.current.canPaste(tab.panes.b)).toBe(true);

  act(() => result.current.pasteClipboard('a', tab.panes.a));
  expect(confirmOverwriteIfNeeded).toHaveBeenCalledTimes(1);
  act(() => result.current.copyToClipboard('a', tab.panes.a));
  act(() => result.current.pasteClipboard('b', tab.panes.b));
  expect(confirmOverwriteIfNeeded).toHaveBeenCalledTimes(2);
  dispose();
});
