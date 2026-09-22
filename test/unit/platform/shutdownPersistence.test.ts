import assert from 'node:assert/strict';
import test from 'node:test';
import {
  flushShutdownState,
  registerShutdownWriter,
} from '../../../src/platform/shutdownPersistence.ts';

test('shutdown starts all owners, waits for slow writes and reports any failure', async () => {
  let release!: () => void;
  let secondStarted = false;
  const clean = [
    registerShutdownWriter(
      'slow',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
    registerShutdownWriter('failed', async () => {
      secondStarted = true;
      throw new Error('disk full');
    }),
  ];
  try {
    let complete = false;
    const closing = flushShutdownState().then((ok) => {
      complete = true;
      return ok;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, true);
    assert.equal(complete, false);
    release();
    assert.equal(await closing, false);
  } finally {
    clean.forEach((dispose) => dispose());
  }
});

test('cleanup of a previous mount cannot unregister the current state owner', async () => {
  const old = registerShutdownWriter('tabs', async () => {
    throw new Error('old mount');
  });
  let called = false;
  const current = registerShutdownWriter('tabs', async () => {
    called = true;
  });
  old();
  try {
    assert.equal(await flushShutdownState(), true);
    assert.equal(called, true);
  } finally {
    current();
  }
});
