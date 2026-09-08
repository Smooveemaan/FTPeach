import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import SettingsDialog from '../../../src/features/settings/SettingsDialog.tsx';
import type { SettingsDialogProps } from '../../../src/features/settings/SettingsDialog.tsx';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderDialog(overrides: Partial<SettingsDialogProps> = {}) {
  const props: SettingsDialogProps = {
    concurrency: 0,
    connectTimeout: 0,
    notifyOnTransferComplete: false,
    overwriteAction: 'ask',
    ftpActiveMode: false,
    proxyEnabled: false,
    proxyType: 'socks5',
    proxyHost: '',
    proxyPort: 1080,
    proxyUsername: '',
    proxyPasswordSet: false,
    preventSleepDuringTransfers: true,
    transferSpeedLimitKBps: 0,
    openWithAssociations: {},
    theme: 'system',
    language: 'en',
    interfaceScale: 100,
    dateFormat: 'locale',
    defaultLocalPath: '',
    showHiddenFiles: false,
    coloredTabs: true,
    minimizeToTray: false,
    closeToTray: false,
    autoCheckUpdates: true,
    autoReconnectTabs: false,
    saveSessionOnExit: true,
    updateStatus: null,
    checkForUpdates: vi.fn(),
    onExportDiagnostics: vi.fn(async () => ({ ok: true })),
    logEnabled: false,
    logShowTimestamps: false,
    logToFile: false,
    vaultAutoLockMinutes: 0,
    showSecurityConfirmations: true,
    keyboardShortcuts: {},
    paneOrientation: 'vertical',
    narrow: false,
    onPreview: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<SettingsDialog {...props} />), props };
}

describe('SettingsDialog unsaved-changes gate', () => {
  test('awaits persistence, prevents duplicate saves and preserves the draft on failure', async () => {
    const user = userEvent.setup();
    let finish!: (_value: { ok: boolean; error?: string }) => void;
    const onSave = vi.fn(
      () =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const { props } = renderDialog({ onSave });
    await toggleNotifyOnComplete(user);
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'common.save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(onSave).toHaveBeenCalledOnce();
    finish({ ok: false, error: 'Store is read-only' });
    expect((await screen.findByRole('alert')).textContent).toContain('Store is read-only');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'settings.notifyOnComplete' }).checked,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ notifyOnTransferComplete: true }),
    );
    finish({ ok: true });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        vault: {
          status: vi.fn(async () => ({
            configured: false,
            locked: true,
            systemUnlockAvailable: false,
            systemUnlockEnabled: false,
          })),
        },
        settings: {
          revealProxyPassword: vi.fn(),
        },
      },
    });
  });

  test('closes immediately when nothing changed', () => {
    const { props } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  test('selects and saves an explicit date/time format', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'settings.categories.interface' }));
    await user.click(screen.getByRole('button', { name: 'settings.dateFormatOnlyLabel' }));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'settings.timeFormatLabel' }).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('option', { name: 'DD/MM/YYYY' }));
    await user.click(screen.getByRole('button', { name: 'settings.timeFormatLabel' }));
    await user.click(screen.getByRole('option', { name: 'settings.timeFormat12Hour' }));
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ dateFormat: 'dd/MM/yyyy hh:mm a' }),
    );
  });

  test('keeps ISO 8601 available as a separate date/time format', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'settings.categories.interface' }));
    await user.click(screen.getByRole('button', { name: 'settings.dateFormatOnlyLabel' }));
    await user.click(screen.getByRole('option', { name: /settings\.dateFormatIso/ }));
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ dateFormat: 'iso' }));
  });

  async function toggleNotifyOnComplete(user: UserEvent): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'settings.categories.transfers' }));
    await user.click(screen.getByRole('checkbox', { name: 'settings.notifyOnComplete' }));
  }

  test('prompts to save when the close button is clicked after an edit', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await toggleNotifyOnComplete(user);
    await user.click(screen.getByRole('button', { name: 'common.close' }));
    expect(props.onClose).not.toHaveBeenCalled();

    const confirmDialog = screen.getByRole('dialog', { name: 'settings.unsavedChangesTitle' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'common.save' }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ notifyOnTransferComplete: true }),
    );
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  test('Cancel discards an edit and closes without prompting', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await toggleNotifyOnComplete(user);
    await user.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(screen.queryByRole('dialog', { name: 'settings.unsavedChangesTitle' })).toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ notifyOnTransferComplete: false }),
    );
  });

  test('"Don\'t Save" discards the edit, reverts the preview and closes', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await toggleNotifyOnComplete(user);
    await user.click(screen.getByRole('button', { name: 'common.close' }));

    const confirmDialog = screen.getByRole('dialog', { name: 'settings.unsavedChangesTitle' });
    await user.click(
      within(confirmDialog).getByRole('button', { name: 'settings.discardChanges' }),
    );
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ notifyOnTransferComplete: false }),
    );
  });

  test('Cancel on the prompt keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await toggleNotifyOnComplete(user);
    await user.click(screen.getByRole('button', { name: 'common.close' }));

    const confirmDialog = screen.getByRole('dialog', { name: 'settings.unsavedChangesTitle' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'common.cancel' }));

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'settings.unsavedChangesTitle' })).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'settings.notifyOnComplete' }).checked,
    ).toBe(true);
  });

  test('editing the proxy password flags unsaved changes and is included in the save patch', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ proxyEnabled: true, proxyHost: '203.0.113.5' });

    await user.click(screen.getByRole('button', { name: 'settings.categories.connection' }));
    await user.type(screen.getByLabelText('settings.proxy.passwordLabel'), 'hunter2');

    await user.click(screen.getByRole('button', { name: 'common.close' }));
    const confirmDialog = screen.getByRole('dialog', { name: 'settings.unsavedChangesTitle' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'common.save' }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ proxyPassword: 'hunter2' }),
    );
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  test('removing a saved proxy password flags unsaved changes and requests removal on save', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      proxyEnabled: true,
      proxyHost: '203.0.113.5',
      proxyPasswordSet: true,
    });

    await user.click(screen.getByRole('button', { name: 'settings.categories.connection' }));
    await user.click(screen.getByRole('button', { name: 'settings.proxy.removeSavedPassword' }));

    await user.click(screen.getByRole('button', { name: 'common.close' }));
    const confirmDialog = screen.getByRole('dialog', { name: 'settings.unsavedChangesTitle' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'common.save' }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ removeProxyPassword: true }),
    );
  });

  test('clears a revealed saved proxy password on blur without persisting it', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.settings.revealProxyPassword).mockResolvedValue('revealed-proxy-secret');
    const { props } = renderDialog({
      proxyEnabled: true,
      proxyHost: '203.0.113.5',
      proxyPasswordSet: true,
    });

    await user.click(screen.getByRole('button', { name: 'settings.categories.connection' }));
    const input = screen.getByLabelText<HTMLInputElement>('settings.proxy.passwordLabel');
    await user.click(screen.getByRole('button', { name: 'common.showPassword' }));
    expect(input.value).toBe('revealed-proxy-secret');

    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(input.value).toBe(''));
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.not.objectContaining({ proxyPassword: expect.anything() }),
    );
  });

  test('exports diagnostics from the Logging settings category', async () => {
    const user = userEvent.setup();
    const onExportDiagnostics = vi.fn(async () => ({ ok: true }));
    renderDialog({ onExportDiagnostics });

    await user.click(screen.getByRole('button', { name: 'settings.categories.logging' }));
    await user.click(screen.getByRole('button', { name: 'settings.exportDiagnostics' }));

    expect(onExportDiagnostics).toHaveBeenCalledOnce();
  });

  test('saves the security confirmation preference', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'settings.categories.security' }));
    await user.click(screen.getByRole('checkbox', { name: 'settings.security.showConfirmations' }));
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ showSecurityConfirmations: false }),
    );
  });
});
