import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { TabState } from '../../../src/features/file-browser/panes/paneModel.ts';
import { usePaneSessionPersistence } from '../../../src/features/file-browser/panes/usePaneSessionPersistence.ts';
import { createTabsApi } from '../../../src/platform/api/tabs.ts';
import type { InvokeArgs, InvokeFn, InvokeResult } from '../../../src/platform/ipcContracts.ts';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';
import { flushShutdownState } from '../../../src/platform/shutdownPersistence.ts';

type Handler = (_args: InvokeArgs | undefined) => unknown;

const DISK_FULL = { ok: false, error: 'The disk is full', errorCode: 'storageFull' };

/**
 * The tabs namespace is the real one over a stubbed transport, so the test sees
 * whatever the shipped API does with a backend answer -- which is the whole
 * point here: a write that fails must not read as a write that worked.
 */
function installApi(handlers: Record<string, Handler>) {
  const calls: Array<{ command: string; args: InvokeArgs | undefined }> = [];
  const invoke: InvokeFn = async <T,>(command: string, args?: InvokeArgs) => {
    calls.push({ command, args });
    return (command in handlers ? handlers[command]!(args) : undefined) as InvokeResult<T>;
  };
  window.api = {
    tabs: createTabsApi(invoke),
    sites: { list: async () => [] },
    settings: { get: async () => ({ saveSessionOnExit: true }) },
  } as unknown as Window['api'];
  return calls;
}

interface HarnessProps {
  tabs: TabState[];
  saveSessionOnExit: boolean;
}

function renderPersistence(initialProps: HarnessProps) {
  return renderHook(
    ({ tabs, saveSessionOnExit }: HarnessProps) =>
      usePaneSessionPersistence({
        tabs,
        activeTabId: tabs[0]!.id,
        setTabs: vi.fn(),
        setActiveTabId: vi.fn(),
        panes: tabs[0]!.panes,
        saveSessionOnExit,
        refreshPane: async () => undefined,
        connectPane: () => async () => undefined,
      }),
    { initialProps },
  );
}

const named = (name: string): TabState[] => {
  const tab = makeTab('tab-1');
  return [{ ...tab, name }];
};

describe('pane session persistence', () => {
  let failures: unknown[];
  let releaseSink: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    failures = [];
    releaseSink = setAsyncFailureSink((error) => failures.push(error));
  });

  afterEach(() => {
    releaseSink();
    vi.useRealTimers();
  });

  const messages = () =>
    failures.map((failure) =>
      typeof failure === 'object' && failure !== null && 'message' in failure
        ? String((failure as { message?: unknown }).message)
        : String(failure),
    );

  test('immediate shutdown saves the latest tabs without waiting for debounce', async () => {
    const calls = installApi({ tabs_get: () => ({}), tabs_set: () => ({ ok: true }) });
    const h = renderPersistence({ tabs: named('before'), saveSessionOnExit: true });
    await act(async () => {});
    h.rerender({ tabs: named('last change'), saveSessionOnExit: true });
    await act(async () => {
      expect(await flushShutdownState()).toBe(true);
    });
    const writes = calls.filter((call) => call.command === 'tabs_set');
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0]?.args)).toContain('last change');
  });

  test('disabling session saving during an older write flushes clear last', async () => {
    let finish!: (_value: unknown) => void;
    const calls = installApi({
      tabs_get: () => ({}),
      tabs_set: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      tabs_clear: () => ({ ok: true }),
    });
    const h = renderPersistence({ tabs: named('old'), saveSessionOnExit: true });
    await settle(h);
    h.rerender({ tabs: named('new'), saveSessionOnExit: false });
    let done = false;
    const closing = flushShutdownState().then((ok) => {
      done = true;
      return ok;
    });
    await act(async () => {});
    expect(done).toBe(false);
    await act(async () => {
      finish({ ok: true });
      expect(await closing).toBe(true);
    });
    expect(calls.filter((call) => call.command.startsWith('tabs_')).at(-1)?.command).toBe(
      'tabs_clear',
    );
  });

  test('returning to an earlier saved snapshot still wins over an in-flight different snapshot', async () => {
    let release: ((_value: unknown) => void) | undefined;
    const writes: string[] = [];
    installApi({
      tabs_get: () => ({}),
      tabs_set: (args) => {
        writes.push(JSON.stringify(args));
        if (writes.length === 2)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { ok: true };
      },
    });
    const h = renderPersistence({ tabs: named('original'), saveSessionOnExit: true });
    await settle(h);
    await settle(h, { tabs: named('intermediate'), saveSessionOnExit: true });
    h.rerender({ tabs: named('original'), saveSessionOnExit: true });
    const closing = flushShutdownState();
    await act(async () => {
      release!({ ok: true });
      expect(await closing).toBe(true);
    });
    expect(writes).toHaveLength(3);
    expect(writes.at(-1)).toContain('original');
  });

  const settle = async (
    harness: { rerender: (_props: HarnessProps) => void },
    props?: HarnessProps,
  ) => {
    if (props) harness.rerender(props);
    // A state update React saw outside act() -- hydration finishing -- is
    // flushed when the surrounding act() exits, so the effect that schedules
    // the write only runs after this first block. Advancing the clock in the
    // same block would move it past a write that had not been scheduled yet.
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {});
  };

  test('a refused tab write reaches the user instead of passing for saved', async () => {
    installApi({ tabs_get: () => ({}), tabs_set: () => DISK_FULL });
    const harness = renderPersistence({ tabs: named(''), saveSessionOnExit: true });
    await settle(harness);

    expect(messages()).toEqual(['The disk is full']);
  });

  test('a rejected tab write is reported the same way as a refused one', async () => {
    installApi({
      tabs_get: () => ({}),
      tabs_set: () => {
        throw new Error('The connection to the backend is gone');
      },
    });
    const harness = renderPersistence({ tabs: named(''), saveSessionOnExit: true });
    await settle(harness);

    expect(messages()).toEqual(['The connection to the backend is gone']);
  });

  test('the same failure is shown once, and a later one is shown again', async () => {
    let answer: unknown = DISK_FULL;
    installApi({ tabs_get: () => ({}), tabs_set: () => answer });
    const harness = renderPersistence({ tabs: named(''), saveSessionOnExit: true });
    await settle(harness);
    await settle(harness, { tabs: named('one'), saveSessionOnExit: true });
    expect(messages()).toEqual(['The disk is full']);

    answer = undefined;
    await settle(harness, { tabs: named('two'), saveSessionOnExit: true });
    answer = DISK_FULL;
    await settle(harness, { tabs: named('three'), saveSessionOnExit: true });

    expect(messages()).toEqual(['The disk is full', 'The disk is full']);
  });

  test('a successful write is silent and carries the tab state', async () => {
    const calls = installApi({ tabs_get: () => ({}), tabs_set: () => undefined });
    const harness = renderPersistence({ tabs: named('one'), saveSessionOnExit: true });
    await settle(harness);

    expect(failures).toEqual([]);
    const write = calls.find(({ command }) => command === 'tabs_set');
    expect(write?.args).toMatchObject({
      state: { activeTabId: 'tab-1', tabs: [{ id: 'tab-1', name: 'one' }] },
    });
  });

  test('turning session saving off reports a clear that did not happen', async () => {
    installApi({ tabs_get: () => ({}), tabs_set: () => undefined, tabs_clear: () => DISK_FULL });
    const harness = renderPersistence({ tabs: named(''), saveSessionOnExit: true });
    await settle(harness);
    await settle(harness, { tabs: named(''), saveSessionOnExit: false });

    expect(messages()).toEqual(['The disk is full']);
  });

  test('an older snapshot never lands after a newer one', async () => {
    const pending: Array<(_value: unknown) => void> = [];
    const written: unknown[] = [];
    installApi({
      tabs_get: () => ({}),
      tabs_set: (args) => {
        written.push(args);
        return new Promise((resolve) => pending.push(resolve));
      },
    });
    const harness = renderPersistence({ tabs: named('one'), saveSessionOnExit: true });
    await settle(harness);
    expect(written).toHaveLength(1);

    // The second write waits for the first to answer: tabs_set replaces the
    // whole state, so an older snapshot landing last would restore stale tabs.
    await settle(harness, { tabs: named('two'), saveSessionOnExit: true });
    expect(written).toHaveLength(1);

    await act(async () => {
      pending.shift()?.(undefined);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(written).toHaveLength(2);
    expect(
      written.map((args) => (args as { state: { tabs: { name: string }[] } }).state.tabs[0]!.name),
    ).toEqual(['one', 'two']);
  });
});
