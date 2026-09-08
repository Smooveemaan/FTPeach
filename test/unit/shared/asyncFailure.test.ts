import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handler,
  reportAsyncFailure,
  reportRejection,
  setAsyncFailureSink,
} from '../../../src/shared/asyncFailure.ts';

test('sink replacement survives stale disposal and current disposal restores console fallback', (t) => {
  const errors: unknown[] = [];
  const old = setAsyncFailureSink(() => assert.fail('stale sink'));
  const dispose = setAsyncFailureSink((error) => errors.push(error));
  t.after(dispose);
  old();
  reportAsyncFailure('current');
  assert.deepEqual(errors, ['current']);
  dispose();
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    reportAsyncFailure('fallback');
    assert.deepEqual(calls, [['Unreported async failure', 'fallback']]);
  } finally {
    console.error = original;
  }
});

test('handlers forward arguments, return void and report both synchronous throws and rejections', async (t) => {
  const errors: unknown[] = [];
  t.after(setAsyncFailureSink((error) => errors.push(error)));
  const error = new Error('failed');
  assert.equal(
    handler((value: number) => {
      assert.equal(value, 42);
      return 'ignored';
    })(42),
    undefined,
  );
  assert.doesNotThrow(() =>
    handler(() => {
      throw error;
    })(),
  );
  handler(() => Promise.reject(error))();
  reportRejection(Promise.reject('rejection'));
  reportRejection(Promise.resolve('success'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [error, error, 'rejection']);
});
