import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useFileClipboard } from '../../../src/features/file-browser/useFileClipboard.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { useDragMove } from '../../../src/features/file-browser/components/useDragMove.ts';

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
