// Random sequences of what users and the backend do to uploads, from a seed:
// start, pause, stop, retry, the backend answering, progress, an old attempt's
// late event and a disconnect, with the queue's invariants checked after each
// step. A failure names its seed and the steps that led to it.
import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, test, vi } from 'vitest';
import { getTransfersSnapshot, useTransfers } from '../../../src/features/transfers/index.ts';
import {
  resetTransfersStoreForTests,
  setTransfersStore,
} from '../../../src/features/transfers/transferStore.ts';
import { readyUnsubscribe } from '../../../src/platform/ipcContracts.ts';
import type { CommandResult, TransferProgress } from '../../../src/platform/ipcContracts.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';

beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockImplementation(randomUUID);
});

/** mulberry32: small, seedable, and the same on every machine. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(items: readonly T[]): T | undefined =>
    items.length ? items[Math.floor(next() * items.length)] : undefined;
  return { next, pick };
}

/** One upload command the backend has been given, answered or not. */
interface Attempt {
  id: string;
  connectionId: string;
  answer: (_result: CommandResult) => void;
  answered: boolean;
  /** The pool was told to cancel it; its command still has to return. */
  cancelled: boolean;
}

/** The backend as the queue sees it: a command returns only when this test says so. */
function fakeBackend() {
  const attempts = new Map<string, Attempt>();
  const cancels: { connectionId: string; id: string }[] = [];
  let listener: ((_payload: TransferProgress) => void) | null = null;
  const transfer = {
    ...tauriApi.transfer,
    onProgress: (callback: (_payload: TransferProgress) => void) => {
      listener = callback;
      return readyUnsubscribe(() => {
        listener = null;
      });
    },
    onDragOutStarted: () => readyUnsubscribe(() => undefined),
    upload: (connectionId: string, id: string) =>
      new Promise<CommandResult>((resolve) => {
        assert.ok(!attempts.has(id), `attempt ${id} sent twice`);
        attempts.set(id, {
          id,
          connectionId,
          answered: false,
          cancelled: false,
          answer: (result) => {
            attempts.get(id)!.answered = true;
            resolve(result);
          },
        });
      }),
    cancel: (connectionId: string, id: string) => {
      cancels.push({ connectionId, id });
      const attempt = attempts.get(id);
      if (attempt && !attempt.answered) attempt.cancelled = true;
      return Promise.resolve({ ok: true });
    },
  };
  return {
    attempts,
    cancels,
    transfer,
    emit: (payload: TransferProgress) => listener?.(payload),
    live: () => [...attempts.values()].filter((attempt) => !attempt.answered),
  };
}

const ACTIVE = ['queued', 'progress', 'cancelling'];
/** Every status any sequence passed through, so a run that exercised nothing fails. */
const seen = new Set<string>();
const copy = () => JSON.parse(JSON.stringify(getTransfersSnapshot())) as unknown;

async function runSequence(seed: number, steps: number) {
  resetTransfersStoreForTests();
  const backend = fakeBackend();
  const previousApi = window.api;
  window.api = {
    ...tauriApi,
    transfer: backend.transfer,
    session: { ...tauriApi.session, list: async () => ({ ok: true, entries: [] }) },
  };
  const { result, unmount } = renderHook(() =>
    useTransfers({
      confirmOverwriteBatch: async () => true,
      confirmMerge: async () => true,
      setErrorMessage: () => undefined,
    }),
  );
  const { next, pick } = random(seed);
  const log: string[] = [];
  const connections = ['c0'];
  const dead = new Set<string>();
  const settle = () =>
    act(async () => {
      // setImmediate, not setTimeout: a Windows timer tick is about 15 ms.
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    });
  // Every row here is an upload; the narrowing gives them their connection.
  const rows = () =>
    Object.values(getTransfersSnapshot()).flatMap((row) => (row.direction === 'up' ? [row] : []));
  const fail = (message: string): never =>
    assert.fail(`seed ${seed}: ${message}\nsteps:\n  ${log.join('\n  ')}`);

  const check = () => {
    const live = backend.live();
    for (const row of rows()) {
      const mine = live.filter((attempt) => attempt.id === row.attemptId);
      if (ACTIVE.includes(row.status) && mine.length === 0)
        fail(`${row.id} is ${row.status} but its attempt already returned`);
      // A disconnect settles its rows at once; their commands still unwind,
      // but nothing can start on that connection again.
      if (!ACTIVE.includes(row.status) && mine.length > 0 && !dead.has(row.connectionId))
        fail(`${row.id} is ${row.status} while its attempt still runs`);
    }
    // A row runs at most one attempt: any live attempt is some row's current one.
    const current = new Set(rows().map((row) => row.attemptId));
    for (const attempt of live) {
      if (!current.has(attempt.id)) fail(`attempt ${attempt.id} runs for no row`);
    }
    for (const { connectionId, id } of backend.cancels) {
      const attempt = backend.attempts.get(id);
      if (attempt && attempt.connectionId !== connectionId)
        fail(`cancel of ${id} went to ${connectionId}, not ${attempt.connectionId}`);
    }
  };

  const actions: Record<string, () => Promise<void> | void> = {
    start: () => {
      const connectionId = pick(connections.filter((id) => !dead.has(id)))!;
      const file = `f${Math.floor(next() * 4)}.bin`;
      log.push(`start ${file} on ${connectionId}`);
      void result.current.runUpload(connectionId, 'ftp', `C:\\local\\${file}`, file, '/remote');
    },
    pause: () => {
      const row = pick(rows());
      if (!row) return;
      log.push(`pause ${row.id} (${row.status})`);
      void result.current.pauseTransfer(row.id);
    },
    stop: () => {
      const row = pick(rows());
      if (!row) return;
      log.push(`stop ${row.id} (${row.status})`);
      void result.current.stopTransfer(row.id);
    },
    retry: () => {
      const row = pick(rows());
      if (!row) return;
      log.push(`retry ${row.id} (${row.status})`);
      void result.current.retryTransfer(row.id);
    },
    answer: () => {
      const attempt = pick(backend.live());
      if (!attempt) return;
      const outcome = attempt.cancelled
        ? { ok: false, error: 'Canceled by user', errorCode: 'cancelled' as const }
        : pick([{ ok: true }, { ok: false, error: 'The server refused it' }])!;
      log.push(`backend answers ${attempt.id.slice(0, 8)} ${outcome.ok ? 'ok' : outcome.error}`);
      attempt.answer(outcome);
    },
    progress: () => {
      const attempt = pick(backend.live().filter((live) => !live.cancelled));
      if (!attempt) return;
      log.push(`progress ${attempt.id.slice(0, 8)}`);
      backend.emit({
        id: attempt.id,
        connectionId: attempt.connectionId,
        status: 'progress',
        bytes: Math.floor(next() * 100),
        total: 100,
      });
    },
    late: () => {
      // An attempt no row runs any more, and the events it can still send.
      const current = new Set(rows().map((row) => row.attemptId));
      const old = pick([...backend.attempts.values()].filter((a) => !current.has(a.id)));
      if (!old) return;
      const status = pick(['queued', 'progress', 'done', 'error'] as const)!;
      log.push(`late ${status} from ${old.id.slice(0, 8)}`);
      const before = copy();
      act(() =>
        backend.emit({ id: old.id, connectionId: old.connectionId, status, bytes: 1, total: 1 }),
      );
      assert.deepEqual(copy(), before, `seed ${seed}: an old attempt's event changed the queue`);
    },
    disconnect: () => {
      const connectionId = pick(connections.filter((id) => !dead.has(id)))!;
      log.push(`disconnect ${connectionId}`);
      dead.add(connectionId);
      connections.push(`c${connections.length}`);
      void result.current.stopTransfersForConnection(connectionId);
      // Teardown cancels whatever the pool still runs for it.
      for (const attempt of backend.live()) {
        if (attempt.connectionId === connectionId) attempt.cancelled = true;
      }
    },
  };
  const weights: [string, number][] = [
    ['start', 4],
    ['pause', 2],
    ['stop', 2],
    ['retry', 3],
    ['answer', 4],
    ['progress', 2],
    ['late', 2],
    ['disconnect', 1],
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);

  try {
    for (let step = 0; step < steps; step++) {
      let roll = next() * total;
      const [name] = weights.find(([, weight]) => (roll -= weight) < 0)!;
      await act(async () => {
        await actions[name]!();
      });
      await settle();
      for (const row of rows()) seen.add(row.status);
      check();
      // Nothing on a connection that is gone can be started again.
      for (const row of rows().filter((row) => dead.has(row.connectionId))) {
        if (row.status === 'paused') fail(`${row.id} is paused on a closed connection`);
      }
    }
    // The backend answers everything still running: nothing may stay in motion.
    for (let round = 0; backend.live().length && round < 100; round++) {
      await act(async () => actions.answer!());
      await settle();
      check();
    }
    for (const row of rows()) {
      if (ACTIVE.includes(row.status)) fail(`${row.id} is still ${row.status} at the end`);
    }
    // A retry on a closed connection starts nothing.
    const before = backend.attempts.size;
    for (const row of rows().filter((row) => dead.has(row.connectionId))) {
      await act(async () => result.current.retryTransfer(row.id));
    }
    await settle();
    if (backend.attempts.size !== before) fail('a retry on a closed connection started an upload');
  } finally {
    unmount();
    setTransfersStore(() => ({}));
    window.api = previousApi;
  }
}

test('random sequences of queue actions and backend answers keep the queue consistent', async () => {
  for (let seed = 1; seed <= 200; seed++) await runSequence(seed, 40);
  assert.deepEqual([...seen].sort(), [
    'cancelling',
    'done',
    'error',
    'paused',
    'progress',
    'queued',
    'stopped',
  ]);
}, 120_000);
