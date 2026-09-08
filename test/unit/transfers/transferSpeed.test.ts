import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSpeedSample } from '../../../src/features/transfers/transferSpeed.ts';

test('stalled transfer resets speed to zero and recovery starts a fresh sample', () => {
  const samples = {};
  assert.equal(updateSpeedSample(samples, 'a', 100, 'progress', 0), null);
  assert.equal(updateSpeedSample(samples, 'a', 200, 'progress', 1000), 100);
  assert.equal(updateSpeedSample(samples, 'a', 200, 'progress', 3100), 0);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 4100), 100);
});

test('terminal status removes its speed sample', () => {
  const samples = { a: { bytes: 10, time: 0, speed: 10 } };
  assert.equal(updateSpeedSample(samples, 'a', 10, 'error', 1000), null);
  assert.equal(samples.a, undefined);
});
