import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  masterPasswordStrength,
  useVaultSettings,
} from '../../../src/features/settings/hooks/useVaultSettings.ts';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const unlocked = {
  configured: true,
  locked: false,
  systemUnlockAvailable: true,
  systemUnlockEnabled: false,
};
let vault: ReturnType<typeof makeVault>;
function makeVault() {
  return {
    status: vi.fn().mockResolvedValue(unlocked),
    setup: vi.fn().mockResolvedValue({ ok: true }),
    unlock: vi.fn().mockResolvedValue({ ok: true }),
    lock: vi.fn().mockResolvedValue({ ok: true }),
    changePassword: vi.fn().mockResolvedValue({ ok: true }),
    reset: vi.fn().mockResolvedValue({ ok: true }),
    useSystemProtection: vi.fn().mockResolvedValue({ ok: true }),
    enableSystemUnlock: vi.fn().mockResolvedValue({ ok: true }),
    disableSystemUnlock: vi.fn().mockResolvedValue({ ok: true }),
  };
}
beforeEach(() => {
  vault = makeVault();
  window.api = { vault } as unknown as Window['api'];
});
afterEach(() => vi.useRealTimers());

function Form() {
  const model = useVaultSettings();
  return (
    <>
      <input aria-label="password" ref={model.masterPasswordRef} />
      <input aria-label="confirmation" ref={model.masterPasswordConfirmRef} />
      <input aria-label="old password" ref={model.oldMasterPasswordRef} />
      <button onClick={() => void model.setupVault()}>setup</button>
      <button onClick={() => void model.unlockVault()}>unlock</button>
      <button onClick={() => void model.changeVaultPassword()}>change</button>
      <output>{model.vaultMessage}</output>
      <span data-testid="invalid">{String(model.vaultUnlockInvalid)}</span>
      <span data-testid="busy">{String(model.vaultBusy)}</span>
    </>
  );
}
const input = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });

test.each([
  ['', ''],
  ['short', 'tooShort'],
  ['😀'.repeat(6), 'tooShort'],
  ['a'.repeat(12), 'acceptable'],
  ['a'.repeat(16), 'acceptable'],
  ['Abcdefghijklmnop1', 'strong'],
  ['界'.repeat(12), 'acceptable'],
])('password strength counts Unicode characters: %s', (value, expected) => {
  expect(masterPasswordStrength(value)).toBe(expected);
});

test.each(['setup', 'change'])(
  '%s validates before sending passwords and clears fields after success',
  async (action) => {
    render(<Form />);
    await waitFor(() => expect(vault.status).toHaveBeenCalledOnce());
    input('password', 'short');
    fireEvent.click(screen.getByText(action, { selector: 'button' }));
    expect(screen.getByText('settings.security.passwordTooShort')).toBeTruthy();
    input('password', 'long-password-123');
    input('confirmation', 'different');
    fireEvent.click(screen.getByText(action, { selector: 'button' }));
    expect(screen.getByText('settings.security.passwordMismatch')).toBeTruthy();
    expect(vault.setup).not.toHaveBeenCalled();
    expect(vault.changePassword).not.toHaveBeenCalled();
    input('confirmation', 'long-password-123');
    input('old password', 'previous-password');
    fireEvent.click(screen.getByText(action, { selector: 'button' }));
    await waitFor(() => expect(vault.status).toHaveBeenCalledTimes(2));
    if (action === 'setup') expect(vault.setup).toHaveBeenCalledWith('long-password-123');
    else
      expect(vault.changePassword).toHaveBeenCalledWith('previous-password', 'long-password-123');
    for (const label of ['password', 'confirmation', 'old password']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    }
  },
);

test('unlock requires a password, retains rejected input, and clears it after success', async () => {
  render(<Form />);
  await waitFor(() => expect(vault.status).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('unlock', { selector: 'button' }));
  expect(vault.unlock).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByLabelText('password'));
  expect(screen.getByTestId('invalid').textContent).toBe('true');
  vault.unlock.mockResolvedValueOnce({ ok: false, error: 'wrong password' });
  input('password', 'wrong');
  fireEvent.click(screen.getByText('unlock', { selector: 'button' }));
  await screen.findByText('wrong password');
  expect((screen.getByLabelText('password') as HTMLInputElement).value).toBe('wrong');
  input('password', 'correct');
  fireEvent.click(screen.getByText('unlock', { selector: 'button' }));
  await waitFor(() => expect(vault.status).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText('password') as HTMLInputElement).value).toBe('');
  expect(screen.getByTestId('invalid').textContent).toBe('false');
  expect(screen.getByTestId('busy').textContent).toBe('false');
});

test('unlock IPC errors expire and pending error timers are removed on unmount', async () => {
  vi.useFakeTimers();
  vault.unlock.mockRejectedValue(new Error('offline'));
  const { unmount } = render(<Form />);
  await act(async () => {});
  input('password', 'secret');
  await act(async () => fireEvent.click(screen.getByText('unlock', { selector: 'button' })));
  expect(screen.getByText('offline')).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(screen.queryByText('offline')).toBeNull();
  expect(screen.getByTestId('invalid').textContent).toBe('false');
  await act(async () => fireEvent.click(screen.getByText('unlock', { selector: 'button' })));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  [{ ok: false, errorCode: 'cancelled' as const }, ''],
  [{ ok: false, error: 'disk full' }, 'disk full'],
  [{ ok: false }, 'settings.security.failed'],
])('vault actions distinguish cancellation and failure: %j', async (response, message) => {
  const { result } = renderHook(useVaultSettings);
  await act(async () => {});
  await act(async () => {
    expect(await result.current.runVaultAction(async () => response)).toBe(false);
  });
  expect(result.current.vaultMessage).toBe(message);
  expect(result.current.vaultBusy).toBe(false);
  expect(vault.status).toHaveBeenCalledTimes(2);
});

test('vault actions stay busy until settled and recover from rejected IPC', async () => {
  const { result } = renderHook(useVaultSettings);
  await act(async () => {});
  let reject!: (_error: Error) => void;
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.runVaultAction(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
  });
  expect(result.current.vaultBusy).toBe(true);
  await act(async () => {
    reject(new Error('unavailable'));
    expect(await pending).toBe(false);
  });
  expect(result.current.vaultMessage).toBe('unavailable');
  expect(result.current.vaultBusy).toBe(false);
});

test('auto-lock refreshes status, reports unavailable status and removes its listener', async () => {
  const { result, unmount } = renderHook(useVaultSettings);
  await act(async () => {});
  expect(result.current.vaultStatus?.locked).toBe(false);
  vault.status.mockResolvedValueOnce({ ...unlocked, locked: true });
  await act(async () => {
    window.dispatchEvent(new Event('ftpeach:vault-locked'));
  });
  expect(result.current.vaultStatus?.locked).toBe(true);
  vault.status.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => {
    window.dispatchEvent(new Event('ftpeach:vault-locked'));
  });
  expect(result.current.vaultMessage).toBe('settings.security.unavailable');
  unmount();
  window.dispatchEvent(new Event('ftpeach:vault-locked'));
  expect(vault.status).toHaveBeenCalledTimes(3);
});

test('protection changes refresh status and cancelled resets preserve the setup form', async () => {
  const { result } = renderHook(useVaultSettings);
  await act(async () => {});
  act(() => result.current.setStrongholdSetupArmed(true));
  vault.reset.mockResolvedValueOnce({ ok: false, errorCode: 'cancelled' });
  await act(async () => result.current.resetVault());
  expect(result.current.strongholdSetupArmed).toBe(true);
  await act(async () => result.current.resetVault());
  expect(result.current.strongholdSetupArmed).toBe(false);
  await act(async () => {
    await result.current.lockVault();
    await result.current.selectSystemProtection();
  });
  expect(vault.lock).toHaveBeenCalledOnce();
  expect(vault.useSystemProtection).toHaveBeenCalledOnce();
  // Leaving enhanced protection in the session that set it up selects system protection.
  act(() => result.current.setStrongholdSetupArmed(true));
  await act(async () => {
    await result.current.selectSystemProtection();
  });
  expect(result.current.strongholdSetupArmed).toBe(false);
  vault.status.mockResolvedValue({ ...unlocked, systemUnlockEnabled: true });
  await act(async () => {
    await result.current.toggleSystemUnlock();
  });
  expect(vault.enableSystemUnlock).toHaveBeenCalledOnce();
  await act(async () => {
    await result.current.toggleSystemUnlock();
  });
  expect(vault.disableSystemUnlock).toHaveBeenCalledOnce();
});
