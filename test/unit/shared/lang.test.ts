import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupByUnknownKey, mapWithConcurrency } from '../../../src/shared/lang.ts';

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
