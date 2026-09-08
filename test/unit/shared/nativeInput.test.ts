import assert from 'node:assert/strict';
import test from 'node:test';
import { setNativeInputValue } from '../../../src/shared/nativeInput.ts';

test('native setter bypasses the React-owned property and dispatches bubbling input', () => {
  let nativeValue = '';
  let trackedWrites = 0;
  const events: Event[] = [];
  const input = {
    set value(_value: string) {
      trackedWrites += 1;
    },
    dispatchEvent: (event: Event) => {
      events.push(event);
      return true;
    },
  };
  const prototype = {
    set value(value: string) {
      assert.equal(this, input);
      nativeValue = value;
    },
  };
  setNativeInputValue(input as HTMLInputElement, 'changed', prototype);
  assert.equal(nativeValue, 'changed');
  assert.equal(trackedWrites, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'input');
  assert.equal(events[0]!.bubbles, true);
});

test('missing native setter falls back to assignment; null needs no browser', () => {
  setNativeInputValue(null, 'ignored');
  const input = { value: '', dispatchEvent: () => true };
  setNativeInputValue(input as unknown as HTMLInputElement, 'fallback', {});
  assert.equal(input.value, 'fallback');
});
