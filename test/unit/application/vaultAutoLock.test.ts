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

test('a burst of activity costs one report, not one per event', () => {
  const h = harness();
  for (let index = 0; index < 50; index += 1) {
    h.advance(100);
    h.act();
  }
  assert.equal(h.reports(), 1);
  h.advance(30_000);
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
