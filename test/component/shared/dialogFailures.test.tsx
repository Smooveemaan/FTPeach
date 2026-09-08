import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AboutDialog from '../../../src/components/AboutDialog.tsx';
import ConfirmDialog from '../../../src/components/ConfirmDialog.tsx';
import VaultUnlockDialog from '../../../src/components/VaultUnlockDialog.tsx';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
});
