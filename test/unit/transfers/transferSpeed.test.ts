import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSpeedSample } from '../../../src/features/transfers/transferSpeed.ts';

test('the first bytes start the measurement, not the moment the row appeared', () => {
  const samples = {};
  assert.equal(updateSpeedSample(samples, 'a', 0, 'progress', 0), null);
  // Logging in, opening the file: nothing has moved, so there is no speed yet.
  assert.equal(updateSpeedSample(samples, 'a', 0, 'progress', 500), null);
  assert.equal(updateSpeedSample(samples, 'a', 100, 'progress', 1000), null);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 2000), 200);
});

test('a render with no new bytes leaves the speed alone', () => {
  const samples = {};
  updateSpeedSample(samples, 'a', 0, 'progress', 0);
  updateSpeedSample(samples, 'a', 100, 'progress', 1000);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 2000), 200);
  // Another row's progress redraws the list halfway through.
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 2500), 200);
  assert.equal(updateSpeedSample(samples, 'a', 500, 'progress', 3000), 200);
});

test('two seconds without a byte read 0 B/s, and the measurement starts over', () => {
  const samples = {};
  updateSpeedSample(samples, 'a', 0, 'progress', 0);
  updateSpeedSample(samples, 'a', 100, 'progress', 1000);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 2000), 200);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 3000), 200);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 4100), 0);
  assert.equal(updateSpeedSample(samples, 'a', 700, 'progress', 5000), 0);
  assert.equal(updateSpeedSample(samples, 'a', 700, 'progress', 5100), 0);
  assert.equal(updateSpeedSample(samples, 'a', 900, 'progress', 6000), 200);
});

test('a transfer that sends nothing for two seconds reads 0 B/s until it is measured', () => {
  const samples = {};
  assert.equal(updateSpeedSample(samples, 'a', 0, 'progress', 0), null);
  assert.equal(updateSpeedSample(samples, 'a', 0, 'progress', 2500), 0);
  assert.equal(updateSpeedSample(samples, 'a', 100, 'progress', 3000), 0);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 4000), 200);
});

test('terminal status removes its speed sample', () => {
  const samples = { a: { bytes: 10, time: 0, speed: 10, atChange: true } };
  assert.equal(updateSpeedSample(samples, 'a', 10, 'error', 1000), null);
  assert.equal(samples.a, undefined);
});
