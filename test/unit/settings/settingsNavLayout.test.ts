import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSettingsNavLayout as layout } from '../../../src/features/settings/settingsNavLayout.ts';

test('fractional widths fit exactly without accumulated rounding', () => {
  const result = layout([60.25, 70.5, 80.75, 90.125], 151.25, 1);
  assert.equal(result.start, 1);
  assert.equal(result.end, 2);
  assert.equal(result.width, 151.25);
  assert.equal(result.offset, 60.25);
});

test('resizing packs the last page and resets when everything fits', () => {
  const widths = [80, 90, 100, 110];
  assert.equal(layout(widths, 210, 3).start, 2);
  assert.equal(layout(widths, 300, 3).start, 1);
  const all = layout(widths, 380, 3);
  assert.equal(all.start, 0);
  assert.equal(all.offset, 0);
  assert.equal(all.overflowing, false);
  assert.equal(all.canScrollForward, false);
  assert.equal(all.canScrollBack, false);
});

test('revealing focus moves only as far as necessary', () => {
  const widths = [80, 90, 100, 110];
  assert.equal(layout(widths, 210, 0, 1).start, 0);
  assert.equal(layout(widths, 210, 0, 3).start, 2);
  assert.equal(layout(widths, 210, 2, 0).start, 0);
});

test('empty, zero-sized and oversized layouts remain bounded', () => {
  assert.equal(layout([], 100, 0).end, -1);
  assert.equal(layout([80], 0, 0).width, null);
  const oversized = layout([300, 80], 100, 0);
  assert.equal(oversized.width, 100);
  assert.equal(oversized.canScrollForward, true);
  assert.equal(layout([300, 80], 100, 99).start, 1);
});

test('walking both directions reaches every item without passing either boundary', () => {
  const widths = [63.125, 100.5, 82.25, 95.875, 130.125, 72.5, 91.25];
  for (const available of [80, 180, 300, 600, 1000]) {
    let current = layout(widths, available, 0);
    const seen = new Set<number>();
    for (let step = 0; step < widths.length; step += 1) {
      for (let index = current.start; index <= current.end; index += 1) seen.add(index);
      if (!current.canScrollForward) break;
      const next = layout(widths, available, current.start + 1);
      assert.ok(next.start > current.start);
      current = next;
    }
    assert.equal(seen.size, widths.length);
    assert.equal(layout(widths, available, current.start + 1).start, current.start);
    while (current.canScrollBack) current = layout(widths, available, current.start - 1);
    assert.equal(current.start, 0);
    assert.equal(current.offset, 0);
  }
});
