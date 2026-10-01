import assert from 'node:assert/strict';
import test from 'node:test';
import { installVaultActivityReporting } from '../../../src/app/vaultAutoLock.ts';

type Options = Parameters<typeof installVaultActivityReporting>[0];
type DocumentTarget = NonNullable<Options['documentTarget']>;
type DocumentListener = Parameters<DocumentTarget['addEventListener']>[1];

function harness() {
  const listeners = new Map<string, DocumentListener>();
  let now = 1_000_000;
  let reports = 0;
  const documentTarget: DocumentTarget = {
    addEventListener: (name: string, handler: DocumentListener) => listeners.set(name, handler),
    removeEventListener: (name: string, handler: DocumentListener) => {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
  };
  const cleanup = installVaultActivityReporting({
    vault: {
      noteActivity: () => {
        reports += 1;
      },
    },
    documentTarget,
    clock: { now: () => now },
  });
  return {
    listeners,
    reports: () => reports,
    advance: (ms: number) => {
      now += ms;
    },
    act: (event = 'pointerdown') => {
      const handler = listeners.get(event);
      assert.ok(handler, `no listener for ${event}`);
      handler(new Event(event));
    },
    cleanup,
  };
}

test('mounting reports once, so an unlocked vault does not start out stale', () => {
  const h = harness();
  assert.equal(h.reports(), 1);
  h.cleanup();
});

test('every kind of user activity reports the user is present', () => {
  const h = harness();
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    h.advance(60_000);
    h.act(event);
  }
  assert.equal(h.reports(), 5);
  h.cleanup();
});

test('a burst of activity costs one report a second, not one per event', () => {
  const h = harness();
  for (let index = 0; index < 50; index += 1) {
    h.advance(100);
    h.act();
  }
  // Five seconds of clicking: the report at mounting and one for each second.
  assert.equal(h.reports(), 6);
  h.cleanup();
});

test('the backend hears of the last activity less than a second late', () => {
  const h = harness();
  h.advance(999);
  h.act();
  assert.equal(h.reports(), 1);
  h.advance(1);
  h.act();
  assert.equal(h.reports(), 2);
  h.cleanup();
});

test('after cleanup nothing is reported, so the backend can lock on time', () => {
  const h = harness();
  h.cleanup();
  assert.equal(h.listeners.size, 0);
  h.advance(60_000);
  assert.equal(h.reports(), 1);
});
