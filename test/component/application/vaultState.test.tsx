import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useVaultState } from '../../../src/app/useVaultState.ts';
import { vaultLockEvents } from '../helpers/vaultLocks.ts';

vi.mock('../../../src/platform/api/index.ts', () => ({ api: {} }));

function setup() {
  const status = { configured: true, locked: false };
  const locks = vaultLockEvents();
  const vaultApi = {
    status: vi.fn(async () => ({
      ...status,
      systemUnlockAvailable: false,
      systemUnlockEnabled: false,
    })),
    onLocked: locks.onLocked,
    onUnlocked: locks.onUnlocked,
  };
  const view = renderHook(() => useVaultState(vaultApi));
  return { ...view, status, locks };
}

test('the vault state follows the locks and unlocks the backend announces', async () => {
  const view = setup();
  expect(view.result.current).toBeNull();
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.result.current).toEqual({ configured: true, locked: false });

  view.status.locked = true;
  await act(async () => {
    view.locks.announce('idle');
    await Promise.resolve();
  });
  expect(view.result.current?.locked).toBe(true);

  view.status.locked = false;
  await act(async () => {
    view.locks.announceUnlocked();
    await Promise.resolve();
  });
  expect(view.result.current?.locked).toBe(false);

  view.unmount();
  expect(view.locks.listening()).toBe(0);
});
