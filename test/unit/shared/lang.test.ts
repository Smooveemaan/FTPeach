import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupByUnknownKey, mapSettled, mapWithConcurrency } from '../../../src/shared/lang.ts';

test('unknown-key lookup excludes inherited keys without losing falsy own values', () => {
  const table = { zero: 0, empty: '', disabled: false };
  for (const key of [undefined, 'missing', 'toString', '__proto__'])
    assert.equal(lookupByUnknownKey(table, key), undefined);
  assert.equal(lookupByUnknownKey(table, 'zero'), 0);
  assert.equal(lookupByUnknownKey(table, 'empty'), '');
  assert.equal(lookupByUnknownKey(table, 'disabled'), false);
});

test('concurrent mapping bounds active work and preserves input order despite out-of-order completion', async () => {
  const releases = new Map<number, () => void>();
  const seen: number[] = [];
  const result = mapWithConcurrency([10, 20, 30], 2, async (value, index) => {
    seen.push(index);
    await new Promise<void>((resolve) => releases.set(index, resolve));
    return value * 2;
  });
  assert.deepEqual(seen, [0, 1]);
  releases.get(1)!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [0, 1, 2]);
  releases.get(2)!();
  releases.get(0)!();
  assert.deepEqual(await result, [20, 40, 60]);
});

test('mapping handles empty input, synchronous callbacks and both failure modes', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, () => assert.fail()), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 10, (n) => n + 1), [2, 3]);
  const error = new Error('callback');
  await assert.rejects(
    mapWithConcurrency([1], 1, () => {
      throw error;
    }),
    error,
  );
  await assert.rejects(
    mapWithConcurrency([1], 1, () => Promise.reject(error)),
    error,
  );
});

test('a failed task does not end the batch while another is still working', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const error = new Error('first job failed');

  const batch = mapWithConcurrency([0, 1], 2, async (item) => {
    if (item === 0) throw error;
    await held;
    finished = true;
    return item;
  });
  const settled = batch.then(
    () => 'resolved',
    (reason) => reason,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'the second task is still holding');
  // Nothing may observe the batch as over while a task it started is still
  // changing files: the caller would refresh, clear the clipboard or report a
  // count that the running task is about to contradict.
  const early = await Promise.race([settled, Promise.resolve('pending')]);
  assert.equal(early, 'pending');

  release();
  assert.equal(await settled, error, 'the first failure is still what the caller sees');
  assert.equal(finished, true);
});

test('a failure stops admitting further items, and skipped ones are named', async () => {
  const started: number[] = [];
  const outcomes = await mapSettled([1, 2, 3, 4, 5], 1, (item) => {
    started.push(item);
    if (item === 2) throw new Error('refused');
    return item;
  });

  assert.deepEqual(started, [1, 2], 'nothing is admitted after a failure');
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'rejected', 'skipped', 'skipped', 'skipped'],
  );
});

test('settled mapping can continue past a failure and report every item', async () => {
  const outcomes = await mapSettled(
    ['a', 'b', 'c'],
    2,
    (item) => {
      if (item === 'b') throw new Error('refused');
      return item.toUpperCase();
    },
    { stopOnError: false },
  );

  assert.deepEqual(
    outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : outcome.status)),
    ['A', 'rejected', 'C'],
  );
});

test('concurrency never exceeds the limit or drops below it while work remains', async () => {
  let active = 0;
  let peak = 0;
  const outcomes = await mapSettled(
    Array.from({ length: 200 }, (_, index) => index),
    8,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return true;
    },
  );

  assert.equal(outcomes.length, 200);
  assert.equal(peak <= 8, true, `peak was ${peak}`);
});
