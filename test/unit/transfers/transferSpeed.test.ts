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

for (const interval of [2000, 2500]) {
  test(`byte bursts every ${interval} ms keep a measured speed`, () => {
    const samples = {};
    updateSpeedSample(samples, 'a', 0, 'progress', 0);
    updateSpeedSample(samples, 'a', 100, 'progress', 1000);
    assert.equal(
      updateSpeedSample(samples, 'a', 500, 'progress', 1000 + interval),
      400000 / interval,
    );
    assert.equal(
      updateSpeedSample(samples, 'a', 900, 'progress', 1000 + interval * 2),
      400000 / interval,
    );
  });
}

test('bursts every 2.5 seconds recover from stalls observed by one-second renders', () => {
  const samples = {};
  updateSpeedSample(samples, 'a', 0, 'progress', 0);
  updateSpeedSample(samples, 'a', 100, 'progress', 1000);
  assert.equal(updateSpeedSample(samples, 'a', 100, 'progress', 2000), null);
  assert.equal(updateSpeedSample(samples, 'a', 100, 'progress', 3000), 0);
  assert.equal(updateSpeedSample(samples, 'a', 500, 'progress', 3500), 160);
  assert.equal(updateSpeedSample(samples, 'a', 500, 'progress', 4000), 160);
  assert.equal(updateSpeedSample(samples, 'a', 500, 'progress', 5000), 160);
  assert.equal(updateSpeedSample(samples, 'a', 500, 'progress', 6000), 0);
  assert.equal(updateSpeedSample(samples, 'a', 900, 'progress', 6000), 160);
  assert.equal(updateSpeedSample(samples, 'a', 900, 'progress', 7000), 160);
  assert.equal(updateSpeedSample(samples, 'a', 900, 'progress', 8000), 0);
  assert.equal(updateSpeedSample(samples, 'a', 1300, 'progress', 8500), 160);
});

test('a stall reads 0 B/s until new bytes arrive, then includes the wait in the average', () => {
  const samples = {};
  updateSpeedSample(samples, 'a', 0, 'progress', 0);
  updateSpeedSample(samples, 'a', 100, 'progress', 1000);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 2000), 200);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 3999), 200);
  assert.equal(updateSpeedSample(samples, 'a', 300, 'progress', 4000), 0);
  assert.equal(updateSpeedSample(samples, 'a', 600, 'progress', 5000), 100);
  assert.equal(updateSpeedSample(samples, 'a', 600, 'progress', 5100), 100);
  assert.equal(updateSpeedSample(samples, 'a', 800, 'progress', 6000), 130);
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
