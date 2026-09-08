import assert from 'node:assert/strict';
import test from 'node:test';
import { parseThemeColor } from '../../../src/platform/windowFrame.ts';

test('frame colors parse RGB/RGBA, round and clamp channels', () => {
  const fallback: [number, number, number] = [20, 19, 18];
  for (const color of ['rgb(12, 34, 56)', 'rgba(12, 34, 56, 0.5)', 'rgb(12 34 56 / 1)']) {
    assert.deepEqual(parseThemeColor(color, fallback), [12, 34, 56]);
  }
  assert.deepEqual(parseThemeColor('rgb(-2, 12.6, 300)', fallback), [0, 13, 255]);
  for (const color of [
    '',
    'transparent',
    'rgba(1, 2, 3, 0)',
    'rgb(1, 2)',
    'rgb(1..2, 2, 3)',
    'color(srgb 1 0 0)',
  ]) {
    assert.deepEqual(parseThemeColor(color, fallback), fallback);
  }
});
