import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConsoleForwarder,
  describeConsoleArguments,
} from '../../../src/platform/consoleForwarding.ts';

function fakeClock() {
  let time = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => time,
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, callback });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
    advance(ms: number) {
      time += ms;
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.at <= time) {
          timers.delete(id);
          entry.callback();
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

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

test('consecutive identical messages collapse and flush on message change or after 2 seconds', () => {
  const sent: Array<{ level: number; message: string }> = [];
  const clock = fakeClock();
  const forwarder = createConsoleForwarder(async (_cmd, args) => {
    sent.push({ level: args.level as number, message: args.message as string });
  }, clock);

  for (let i = 0; i < 5; i += 1) {
    forwarder.forward(5, ['render loop error']);
  }
  assert.deepEqual(sent, [{ level: 5, message: 'render loop error' }]);
  assert.equal(clock.pendingTimers(), 1);

  // Switching to a different message flushes the repeat summary first.
  forwarder.forward(4, ['different warning']);
  assert.deepEqual(sent, [
    { level: 5, message: 'render loop error' },
    { level: 5, message: 'render loop error (repeated 4 times)' },
    { level: 4, message: 'different warning' },
  ]);
  assert.equal(clock.pendingTimers(), 0);

  // Repeats without a message change flush after the 2-second timer.
  forwarder.forward(4, ['different warning']);
  forwarder.forward(4, ['different warning']);
  clock.advance(1_999);
  assert.equal(sent.length, 3);
  clock.advance(1);
  assert.deepEqual(sent[3], { level: 4, message: 'different warning (repeated 2 times)' });
  forwarder.dispose();
});

test('flood of distinct messages is capped at 20 per second and reports drops on next window', () => {
  const sent: string[] = [];
  const clock = fakeClock();
  const forwarder = createConsoleForwarder(async (_cmd, args) => {
    sent.push(args.message as string);
  }, clock);

  for (let i = 0; i < 35; i += 1) {
    forwarder.forward(5, [`burst-${i}`]);
  }
  assert.equal(sent.length, 20);

  clock.advance(1_000);
  forwarder.forward(5, ['after-window']);
  assert.equal(sent.length, 21);
  assert.equal(sent[20], 'after-window (dropped 15 rate-limited console messages)');
  forwarder.dispose();
});

test('dispose clears pending repeat timers and stops forwarding', () => {
  const sent: string[] = [];
  const clock = fakeClock();
  const forwarder = createConsoleForwarder(async (_cmd, args) => {
    sent.push(args.message as string);
  }, clock);

  forwarder.forward(5, ['repeat']);
  forwarder.forward(5, ['repeat']);
  assert.equal(clock.pendingTimers(), 1);
  forwarder.dispose();
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(5_000);
  forwarder.forward(5, ['after-dispose']);
  assert.deepEqual(sent, ['repeat']);
});
