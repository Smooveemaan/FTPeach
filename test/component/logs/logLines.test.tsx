import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useLogLines } from '../../../src/features/logs/useLogLines.ts';
import type { LogEntry } from '../../../src/shared/types.ts';

test('Strict Mode replay does not allocate extra IDs or leave subscriptions behind', () => {
  let receive!: (_entries: LogEntry[]) => void;
  const release = vi.fn();
  const logApi = {
    onMessage: vi.fn((callback: (_entries: LogEntry[]) => void) => {
      receive = callback;
      return release;
    }),
  };
  const { result, unmount } = renderHook(() => useLogLines(logApi), { wrapper: StrictMode });
  const entry: LogEntry = { line: 'message', kind: 'info', ts: 1, connectionId: 'connection' };
  act(() => {
    receive([entry]);
    receive([entry]);
  });
  expect(result.current.lines.map((line) => line.id)).toEqual([1, 2]);
  const before = result.current.lines;
  act(() => receive([]));
  expect(result.current.lines).toBe(before);
  act(() => result.current.clear());
  act(() => receive([entry]));
  expect(result.current.lines.map((line) => line.id)).toEqual([3]);
  unmount();
  expect(release).toHaveBeenCalledTimes(logApi.onMessage.mock.calls.length);
});
