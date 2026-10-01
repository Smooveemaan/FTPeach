import { afterEach, expect, test, vi } from 'vitest';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';

type Handler = (_event: { payload: unknown }) => void;
const listen = vi.fn<(_name: string, _handler: Handler) => Promise<() => void>>();
vi.mock('@tauri-apps/api/event', () => ({ listen }));

const { onEvent, tauriApi } = await import('../../../src/platform/tauriApi.ts');
const { VAULT_LOCK_REASONS } = await import('../../../src/platform/ipcContracts.ts');

afterEach(() => listen.mockReset());

function deferred<T>() {
  let resolve!: (_value: T) => void;
  let reject!: (_error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('ready settles once the listener is in place, and events reach the callback', async () => {
  let handler!: Handler;
  listen.mockImplementation(async (_name, next) => {
    handler = next;
    return () => {};
  });
  const received: unknown[] = [];
  const stop = onEvent<number>(
    'count',
    (value): value is number => typeof value === 'number',
  )((payload) => received.push(payload));
  await expect(stop.ready).resolves.toBe(true);
  handler({ payload: 1 });
  handler({ payload: 'not a number' });
  expect(received).toEqual([1]);
});

test('a refused subscription is reported once and never rejects', async () => {
  listen.mockRejectedValue(new Error('no such event'));
  const reported: unknown[] = [];
  const dispose = setAsyncFailureSink((error) => reported.push(error));
  const stop = onEvent('missing')(() => {});
  await expect(stop.ready).resolves.toBe(false);
  expect(String(reported[0])).toMatch(/Could not subscribe to missing: .*no such event/);
  expect(reported).toHaveLength(1);
  dispose();
});

test('stopping before the listener exists removes it once it does', async () => {
  const pending = deferred<() => void>();
  listen.mockReturnValue(pending.promise);
  const unlisten = vi.fn();
  const stop = onEvent('late')(() => {});
  stop();
  pending.resolve(unlisten);
  await expect(stop.ready).resolves.toBe(false);
  expect(unlisten).toHaveBeenCalledTimes(1);
});

test('a refusal after stopping is not reported', async () => {
  const pending = deferred<() => void>();
  listen.mockReturnValue(pending.promise);
  const reported: unknown[] = [];
  const dispose = setAsyncFailureSink((error) => reported.push(error));
  const stop = onEvent('gone')(() => {});
  stop();
  pending.reject(new Error('window closed'));
  await expect(stop.ready).resolves.toBe(false);
  expect(reported).toEqual([]);
  dispose();
});

test('each subscription is independent, so resubscribing after a stop works', async () => {
  const unlisten = vi.fn();
  listen.mockResolvedValue(unlisten);
  const first = onEvent('again')(() => {});
  await first.ready;
  first();
  const second = onEvent('again')(() => {});
  await expect(second.ready).resolves.toBe(true);
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(2);
});

test('a vault lock reaches onLocked with each reason the backend gives, and nothing else', async () => {
  let handler!: Handler;
  listen.mockImplementation(async (name, next) => {
    expect(name).toBe('vault:locked');
    handler = next;
    return () => {};
  });
  const invalid = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reasons: string[] = [];
  const stop = tauriApi.vault.onLocked((locked) => reasons.push(locked.reason));
  await stop.ready;
  for (const reason of VAULT_LOCK_REASONS) handler({ payload: { reason } });
  handler({ payload: { reason: 'shutdown' } });
  expect(reasons).toEqual([...VAULT_LOCK_REASONS]);
  expect(reasons).toContain('user');
  expect(invalid).toHaveBeenCalledOnce();
  invalid.mockRestore();
});
