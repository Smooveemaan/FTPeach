import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AboutDialog from '../../../src/components/AboutDialog.tsx';
import ConfirmDialog from '../../../src/components/ConfirmDialog.tsx';
import VaultUnlockDialog from '../../../src/components/VaultUnlockDialog.tsx';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';
import i18n from '../../../src/i18n/index.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
});

describe('dialog async failures', () => {
  test('reports a failed version lookup while keeping About open', async () => {
    const failure = new Error('version unavailable');
    const sink = vi.fn();
    dispose = setAsyncFailureSink(sink);
    render(
      <AboutDialog
        onClose={vi.fn()}
        appApi={{
          version: vi.fn().mockRejectedValue(failure),
          openExternal: vi.fn(),
        }}
      />,
    );
    await waitFor(() => expect(sink).toHaveBeenCalledWith(failure));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('reports a confirmation failure after closing the dialog', async () => {
    const failure = new Error('delete failed');
    const sink = vi.fn();
    dispose = setAsyncFailureSink(sink);
    const close = vi.fn();
    render(
      <ConfirmDialog
        message="Delete?"
        onConfirm={vi.fn().mockRejectedValue(failure)}
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'paneMenu.delete' }));
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() => expect(sink).toHaveBeenCalledWith(failure));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  test('reports a vault status failure and preserves password unlocking', async () => {
    const failure = new Error('status unavailable');
    const sink = vi.fn();
    dispose = setAsyncFailureSink(sink);
    render(
      <VaultUnlockDialog
        onClose={vi.fn()}
        onUnlocked={vi.fn()}
        vaultApi={{
          status: vi.fn().mockRejectedValue(failure),
          unlock: vi.fn(),
          unlockSystem: vi.fn(),
        }}
      />,
    );
    await waitFor(() => expect(sink).toHaveBeenCalledWith(failure));
    expect(screen.getByLabelText('settings.security.masterPassword')).toBeTruthy();
  });

  test('a refused master password is said in the user’s language, not the backend’s', async () => {
    const backendText = 'Vault authentication failed or temporarily unavailable';
    render(
      <VaultUnlockDialog
        onClose={vi.fn()}
        onUnlocked={vi.fn()}
        vaultApi={{
          status: vi.fn().mockResolvedValue({}),
          unlock: vi
            .fn()
            .mockResolvedValue({ ok: false, errorCode: 'vaultAuthFailed', error: backendText }),
          unlockSystem: vi.fn(),
        }}
      />,
    );
    fireEvent.input(screen.getByLabelText('settings.security.masterPassword'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.security.unlock' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(i18n.t('settings.security.unlockRefused'));
    expect(alert.textContent).not.toBe(backendText);
  });
});
