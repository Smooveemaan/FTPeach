import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeConsoleArguments } from '../../../src/platform/consoleForwarding.ts';

test('console arguments become one line of text for the application log', () => {
  const error = new Error('boom');
  error.stack = 'Error: boom\n    at run (app.js:1:1)';
  assert.equal(
    describeConsoleArguments(['Failed:', error, { code: 7 }, 3]),
    'Failed: Error: boom\n    at run (app.js:1:1) {"code":7} 3',
  );
});

test('values JSON cannot describe still come out as text', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(describeConsoleArguments([cyclic, undefined]), '[unserializable object] undefined');
});

test('a very long message is cut short', () => {
  const text = describeConsoleArguments(['x'.repeat(20_000)]);
  assert.equal(text.length, 8 * 1024 + 1);
  assert.ok(text.endsWith('…'));
});
