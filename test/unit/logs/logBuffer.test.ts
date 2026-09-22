import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLogGap, mergeLogBatch, MAX_LOG_BYTES } from '../../../src/features/logs/logBuffer.ts';

test('byte retention bounds large records even below the entry limit', () => {
  const batch = Array.from({ length: 1000 }, (_, seq) => ({
    seq: seq + 1,
    line: 'x'.repeat(8192),
  }));
  const kept = mergeLogBatch([], batch, 0);
  assert.ok(kept.length < 1000);
  assert.equal(kept.at(-1)?.seq, 1000);
  assert.ok(
    kept.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0) <=
      MAX_LOG_BYTES,
  );
});

test('a large batch keeps only the newest entries, without copying the rest', () => {
  const batch = Array.from({ length: 10000 }, (_, n) => ({ seq: n + 1 }));
  assert.deepEqual(mergeLogBatch([{ seq: 0 }], batch, 0, 3), [
    { seq: 9998 },
    { seq: 9999 },
    { seq: 10000 },
  ]);
});

test('entries the history already returned, or the user cleared, are dropped', () => {
  const history = [{ seq: 4 }, { seq: 5 }];
  assert.equal(mergeLogBatch(history, [{ seq: 4 }, { seq: 5 }], 5), history);
  assert.deepEqual(mergeLogBatch(history, [{ seq: 5 }, { seq: 6 }], 5), [
    { seq: 4 },
    { seq: 5 },
    { seq: 6 },
  ]);
  assert.deepEqual(mergeLogBatch([], [{ seq: 7 }, { seq: 8 }], 7), [{ seq: 8 }]);
});

test('retention keeps original history references and leaves inputs intact', () => {
  const history = [
    { seq: 1, value: 'a' },
    { seq: 2, value: 'b' },
  ];
  const result = mergeLogBatch(history, [{ seq: 3, value: 'c' }], 2, 2);
  assert.equal(result[0], history[1]);
  assert.deepEqual(result, [
    { seq: 2, value: 'b' },
    { seq: 3, value: 'c' },
  ]);
  assert.equal(history.length, 2);
  assert.deepEqual(mergeLogBatch(history, [], 2, 0), []);
});

test('a batch that skips records is a gap; a repeat or the next record is not', () => {
  assert.equal(hasLogGap(5, [{ seq: 7 }]), true);
  assert.equal(hasLogGap(5, [{ seq: 6 }]), false);
  assert.equal(hasLogGap(5, [{ seq: 3 }, { seq: 4 }]), false);
  assert.equal(hasLogGap(0, [{ seq: 1 }]), false);
  assert.equal(hasLogGap(5, []), false);
});
