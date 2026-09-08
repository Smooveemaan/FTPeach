import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialSectionResizeState as initial,
  sectionResizeReducer as reduce,
} from '../../../src/app/layout/sectionResizeReducer.ts';
import type { SectionResizeAction } from '../../../src/app/layout/sectionResizeReducer.ts';

test('resize switches active sections, keeps both touched flags and never mutates input', () => {
  const frozen = Object.freeze({ ...initial });
  let state = reduce(frozen, { type: 'stop' });
  assert.deepEqual(state, initial);
  for (const section of ['transfers', 'log'] as const) {
    state = reduce(state, { type: 'start', section });
    assert.equal(state.activeSection, section);
    state = reduce(state, { type: 'touch', section });
    assert.deepEqual(reduce(state, { type: 'touch', section }), state);
  }
  assert.deepEqual(reduce(state, { type: 'stop' }), {
    activeSection: null,
    transferManuallyResized: true,
    logManuallyResized: true,
  });
  assert.deepEqual(frozen, initial);
});

test('unknown runtime actions preserve state identity; touching needs no active drag', () => {
  assert.equal(reduce(initial, { type: 'unknown' } as unknown as SectionResizeAction), initial);
  assert.equal(reduce(initial, { type: 'touch', section: 'log' }).activeSection, null);
});
