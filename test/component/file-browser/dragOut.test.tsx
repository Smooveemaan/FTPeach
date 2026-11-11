import { readyUnsubscribe } from '../../../src/platform/ipcContracts.ts';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useFileClipboard } from '../../../src/features/file-browser/useFileClipboard.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
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
beforeEach(() => {
  window.api = { dragOut: { onMotion } } as unknown as Window['api'];
});

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
  window.api = { dragOut: { onMotion, start } } as unknown as Window['api'];
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
  window.api = { dragOut: { onMotion, start, startLocal } } as unknown as Window['api'];
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
    window.api = { dragOut: { onMotion, start, startLocal: start } } as unknown as Window['api'];
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
