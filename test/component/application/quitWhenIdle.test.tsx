import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useQuitWhenIdle } from '../../../src/app/quit/useQuitWhenIdle.ts';
import { computeTransferSummary } from '../../../src/features/transfers/useTransferSummary.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

vi.mock('../../../src/platform/api/index.ts', () => ({ api: {} }));

function setup(hasActiveTransfers: boolean) {
  const quit = vi.fn(async () => ({ ok: true }));
  const view = renderHook(
    ({ active }: { active: boolean }) => useQuitWhenIdle({ hasActiveTransfers: active, quit }),
    { initialProps: { active: hasActiveTransfers } },
  );
  return { ...view, quit, setActive: (active: boolean) => view.rerender({ active }) };
}

test('a quit with nothing running goes straight through', () => {
  const view = setup(false);
  act(() => view.result.current.request());
  expect(view.quit).toHaveBeenCalledOnce();
  expect(view.result.current.promptOpen).toBe(false);
});

test('a quit with transfers running asks first', () => {
  const view = setup(true);
  act(() => view.result.current.request());
  expect(view.result.current.promptOpen).toBe(true);
  expect(view.quit).not.toHaveBeenCalled();

  act(() => view.result.current.dismiss());
  expect(view.result.current.promptOpen).toBe(false);
  view.setActive(false);
  expect(view.quit).not.toHaveBeenCalled();
});

test('quit now closes the question and quits once', () => {
  const view = setup(true);
  act(() => view.result.current.request());
  act(() => view.result.current.quitNow());
  act(() => view.result.current.quitNow());
  expect(view.result.current.promptOpen).toBe(false);
  expect(view.quit).toHaveBeenCalledOnce();
});

test('quitting when idle waits for the transfers, including ones started meanwhile', () => {
  const view = setup(true);
  act(() => view.result.current.request());
  act(() => view.result.current.quitWhenIdle());
  expect(view.result.current.pending).toBe(true);
  expect(view.result.current.promptOpen).toBe(false);
  expect(view.quit).not.toHaveBeenCalled();

  // A transfer started while waiting keeps the queue active.
  view.setActive(true);
  expect(view.quit).not.toHaveBeenCalled();
  view.setActive(false);
  expect(view.quit).toHaveBeenCalledOnce();
});

test('paused and failed transfers do not hold the quit up', () => {
  const rows = {
    paused: { id: 'paused', status: 'paused', direction: 'down', bytes: 1, total: 2 },
    failed: { id: 'failed', status: 'error', direction: 'down', bytes: 1, total: 2 },
  } as unknown as Record<string, TransferRow>;
  const view = setup(true);
  act(() => view.result.current.request());
  act(() => view.result.current.quitWhenIdle());
  view.setActive(computeTransferSummary(rows).hasActiveTransfers);
  expect(view.quit).toHaveBeenCalledOnce();
});

test('cancelling stops waiting', () => {
  const view = setup(true);
  act(() => view.result.current.request());
  act(() => view.result.current.quitWhenIdle());
  act(() => view.result.current.cancel());
  expect(view.result.current.pending).toBe(false);
  view.setActive(false);
  expect(view.quit).not.toHaveBeenCalled();
});

test('a question left open quits once the transfers are gone', () => {
  const view = setup(true);
  act(() => view.result.current.request());
  view.setActive(false);
  expect(view.result.current.promptOpen).toBe(false);
  expect(view.quit).toHaveBeenCalledOnce();
});
