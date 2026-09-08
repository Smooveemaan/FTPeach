import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingPersister } from '../../../src/platform/persistSetting.ts';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Result = { ok: boolean; error?: string };

function harness() {
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const calls: {
    patch: Record<string, unknown>;
    resolve: (_result: Result) => void;
    reject: (_error: unknown) => void;
  }[] = [];
  const errors: unknown[] = [];
  let id = 0;
  const persist = createSettingPersister({
    schedule: (callback) => {
      const token = ++id as unknown as ReturnType<typeof setTimeout>;
      timers.set(token, callback);
      return token;
    },
    cancel: (timer) => {
      timers.delete(timer);
    },
    write: (patch) =>
      new Promise<Result>((resolve, reject) => {
        calls.push({ patch, resolve, reject });
      }),
    report: (error) => {
      errors.push(error);
    },
  });
  const tick = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  };
  return { persist, calls, errors, timers, tick };
}

test('settings coalesce rapid changes with the latest value and serialize in-flight writes', async () => {
  const h = harness();
  h.persist({ theme: 'dark', width: 100 });
  h.persist({ width: 120 });
  assert.equal(h.timers.size, 1);
  assert.equal(h.calls.length, 0);
  h.tick();
  assert.deepEqual(h.calls[0]!.patch, { theme: 'dark', width: 120 });
  h.persist({ width: 140 });
  h.tick();
  h.persist({ width: 160, hidden: true });
  assert.equal(h.calls.length, 1);
  h.calls[0]!.resolve({ ok: true });
  await settle();
  assert.deepEqual(h.calls[1]!.patch, { width: 160, hidden: true });
  h.calls[1]!.resolve({ ok: true });
  await settle();
  h.tick();
  assert.equal(h.calls.length, 2);
});

test('failed responses and rejected writes report once and do not block later revisions', async () => {
  for (const rejects of [false, true]) {
    const h = harness();
    h.persist({ value: 1 });
    h.tick();
    h.persist({ value: 2 });
    if (rejects) h.calls[0]!.reject(new Error('offline'));
    else h.calls[0]!.resolve({ ok: false, error: 'offline' });
    await settle();
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.calls[1]!.patch, { value: 2 });
    h.calls[1]!.resolve({ ok: true });
    await settle();
    h.tick();
    assert.equal(h.calls.length, 2);
  }
});
