import assert from 'node:assert/strict';
import test from 'node:test';
import { clampInterfaceScale } from '../../../src/platform/interfaceScale.ts';

test('interface scale clamps limits and preserves fractional percentages without a DOM', () => {
  for (const [input, expected] of [
    [-10, 0.8],
    [79, 0.8],
    [80, 0.8],
    [100, 1],
    [112.5, 1.125],
    [150, 1.5],
    [151, 1.5],
    [-Infinity, 0.8],
    [Infinity, 1.5],
    [NaN, 1],
  ] as const) {
    assert.equal(clampInterfaceScale(input), expected);
  }
});
