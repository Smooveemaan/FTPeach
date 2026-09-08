import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendLogBatch } from '../../../src/features/logs/logBuffer.ts';

test('large batches only materialize retained entries while preserving the ID sequence', () => {
  let reads = 0;
  let id = 0;
  const batch = Array.from({ length: 10000 }, (_, n) => ({
    get value() {
      reads++;
      return n;
    },
  }));
  const result = appendLogBatch([{ value: -1, id: -1 }], batch, () => ++id, 3);
  assert.deepEqual(result, [
    { value: 9997, id: 9998 },
    { value: 9998, id: 9999 },
    { value: 9999, id: 10000 },
  ]);
  assert.equal(reads, 3);
  assert.equal(id, 10000);
});

test('retention keeps original history references and leaves inputs intact', () => {
  const history = [
    { id: 1, value: 'a' },
    { id: 2, value: 'b' },
  ];
  assert.equal(
    appendLogBatch<{ value: string }>(history, [], () => 3, 2),
    history,
  );
  const result = appendLogBatch(history, [{ value: 'c' }], () => 3, 2);
  assert.equal(result[0], history[1]);
  assert.deepEqual(result, [
    { id: 2, value: 'b' },
    { id: 3, value: 'c' },
  ]);
  assert.equal(history.length, 2);
  assert.deepEqual(
    appendLogBatch<{ value: string }>(history, [], () => 3, 0),
    [],
  );
});
