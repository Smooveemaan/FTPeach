import assert from 'node:assert/strict';
import test from 'node:test';
import { installVaultAutoLock } from '../../../src/app/vaultAutoLock.ts';

type AutoLockOptions = Parameters<typeof installVaultAutoLock>[0];
type VaultStatus = Awaited<ReturnType<AutoLockOptions['vault']['status']>>;
type DocumentTarget = NonNullable<AutoLockOptions['documentTarget']>;
type TimerTarget = NonNullable<AutoLockOptions['timerTarget']>;
type DocumentListener = Parameters<DocumentTarget['addEventListener']>[1];

function harness(status: VaultStatus = { configured: true, locked: false }) {
  const listeners = new Map<string, DocumentListener>();
  let callback: (() => void | Promise<void>) | undefined;
  let delay: number | undefined;
  let lockCalls = 0;
  let lockedEvents = 0;
  const documentTarget: DocumentTarget = {
    visibilityState: 'visible',
    addEventListener: (name: string, handler: DocumentListener) => listeners.set(name, handler),
    removeEventListener: (name: string, handler: DocumentListener) => {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
  };
  const timerTarget: TimerTarget = {
    setTimeout: (handler: () => void | Promise<void>, timeout: number) => {
      callback = handler;
      delay = timeout;
      return 1;
    },
    clearTimeout: () => {},
  };
  const vault = {
    status: async () => status,
    lock: async () => {
      lockCalls += 1;
      return { ok: true };
    },
  };
  const cleanup = installVaultAutoLock({
    minutes: 15,
    vault,
    documentTarget,
    timerTarget,
    onLocked: () => {
      lockedEvents += 1;
    },
  });
  return {
    listeners,
    documentTarget,
    runTimer: async () => {
      assert.ok(callback);
      await callback();
    },
    delay: () => delay,
    lockCalls: () => lockCalls,
    lockedEvents: () => lockedEvents,
    cleanup,
  };
}

test('vault auto-lock uses the configured inactivity period', async () => {
  const h = harness();
  assert.equal(h.delay(), 15 * 60_000);
  await h.runTimer();
  assert.equal(h.lockCalls(), 1);
  assert.equal(h.lockedEvents(), 1);
  h.cleanup();
});

test('vault locks immediately when the application enters a hidden state', async () => {
  const h = harness();
  h.documentTarget.visibilityState = 'hidden';
  const visibilityHandler = h.listeners.get('visibilitychange');
  assert.ok(visibilityHandler);
  visibilityHandler(new Event('visibilitychange'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lockCalls(), 1);
  h.cleanup();
});

test('already locked or unconfigured vaults are left alone', async () => {
  for (const status of [
    { configured: true, locked: true },
    { configured: false, locked: true },
  ]) {
    const h = harness(status);
    await h.runTimer();
    assert.equal(h.lockCalls(), 0);
    assert.equal(h.lockedEvents(), 0);
    h.cleanup();
  }
});

test('cleanup prevents an in-flight status check from locking later', async () => {
  let resolveStatus: ((_status: VaultStatus) => void) | undefined;
  const status = new Promise<VaultStatus>((resolve) => {
    resolveStatus = resolve;
  });
  let callback: (() => void | Promise<void>) | undefined;
  let lockCalls = 0;
  const cleanup = installVaultAutoLock({
    minutes: 1,
    vault: {
      status: () => status,
      lock: async () => {
        lockCalls += 1;
        return { ok: true };
      },
    },
    documentTarget: {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    timerTarget: {
      setTimeout: (handler: () => void | Promise<void>) => {
        callback = handler;
        return 1;
      },
      clearTimeout: () => {},
    },
  });
  assert.ok(callback);
  const pending = callback();
  cleanup();
  assert.ok(resolveStatus);
  resolveStatus({ configured: true, locked: false });
  await pending;
  assert.equal(lockCalls, 0);
});
