import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useLogLines } from '../../../src/features/logs/useLogLines.ts';
import type { LogEntry } from '../../../src/shared/types.ts';
import { MAX_LOG_BYTES } from '../../../src/features/logs/logBuffer.ts';

const entry = (seq: number): LogEntry => ({
  seq,
  line: `line ${seq}`,
  kind: 'status',
  ts: seq,
  connectionId: 'connection',
});

function fakeLogApi(history: () => LogEntry[]) {
  const listeners = new Set<(_batch: LogEntry[]) => void>();
  const release = vi.fn((callback: (_batch: LogEntry[]) => void) => listeners.delete(callback));
  return {
    api: {
      recent: vi.fn(async () => history()),
      onMessage: vi.fn((callback: (_batch: LogEntry[]) => void) => {
        listeners.add(callback);
        return () => release(callback);
      }),
    },
    send: (batch: LogEntry[]) => {
      for (const listener of listeners) listener(batch);
    },
    listeners,
  };
}

const seqs = (lines: readonly LogEntry[]) => lines.map((line) => line.seq);

test('a closed panel neither reads the history nor listens', () => {
  const log = fakeLogApi(() => [entry(1)]);
  const { result } = renderHook(() => useLogLines(false, log.api));
  expect(log.api.recent).not.toHaveBeenCalled();
  expect(log.api.onMessage).not.toHaveBeenCalled();
  expect(result.current.lines).toEqual([]);
});

test('live records stay bounded while history is stalled', async () => {
  const log = fakeLogApi(() => []);
  let resolve!: (_entries: LogEntry[]) => void;
  log.api.recent.mockImplementationOnce(
    () =>
      new Promise<LogEntry[]>((done) => {
        resolve = done;
      }),
  );
  const { result } = renderHook(() => useLogLines(true, log.api));
  for (let index = 0; index < 20; index += 1) {
    act(() =>
      log.send(
        Array.from({ length: 128 }, (_, offset) => ({
          ...entry(index * 128 + offset + 1),
          line: 'x'.repeat(8192),
        })),
      ),
    );
  }
  await act(async () => resolve([]));
  expect(result.current.lines.at(-1)?.seq).toBe(2560);
  expect(result.current.lines.length).toBeLessThan(512);
  expect(new TextEncoder().encode(JSON.stringify(result.current.lines)).byteLength).toBeLessThan(
    MAX_LOG_BYTES + 512,
  );
});

test('opening reads the history, then adds live batches without repeating records', async () => {
  const log = fakeLogApi(() => [entry(1), entry(2)]);
  const { result, unmount } = renderHook(() => useLogLines(true, log.api), {
    wrapper: StrictMode,
  });
  // A batch that arrives before the history is in waits for it.
  act(() => log.send([entry(2), entry(3)]));
  await waitFor(() => expect(seqs(result.current.lines)).toEqual([1, 2, 3]));

  const before = result.current.lines;
  act(() => log.send([entry(3)]));
  expect(result.current.lines).toBe(before);
  act(() => log.send([entry(4)]));
  expect(seqs(result.current.lines)).toEqual([1, 2, 3, 4]);

  unmount();
  expect(log.listeners.size).toBe(0);
});

test('a batch that skips records reads the history again', async () => {
  let history = [entry(1)];
  const log = fakeLogApi(() => history);
  const { result } = renderHook(() => useLogLines(true, log.api));
  await waitFor(() => expect(seqs(result.current.lines)).toEqual([1]));

  history = [entry(1), entry(2), entry(3)];
  act(() => log.send([entry(3)]));
  await waitFor(() => expect(seqs(result.current.lines)).toEqual([1, 2, 3]));
  expect(log.api.recent).toHaveBeenCalledTimes(2);
});

test('a cleared log stays cleared when the panel is closed and opened again', async () => {
  const log = fakeLogApi(() => [entry(1), entry(2)]);
  const { result, rerender } = renderHook(({ open }) => useLogLines(open, log.api), {
    initialProps: { open: true },
  });
  await waitFor(() => expect(seqs(result.current.lines)).toEqual([1, 2]));
  act(() => result.current.clear());
  expect(result.current.lines).toEqual([]);

  rerender({ open: false });
  expect(result.current.lines).toEqual([]);
  rerender({ open: true });
  expect(log.api.recent).toHaveBeenCalledTimes(2);
  act(() => log.send([entry(3)]));
  await waitFor(() => expect(seqs(result.current.lines)).toEqual([3]));
});
