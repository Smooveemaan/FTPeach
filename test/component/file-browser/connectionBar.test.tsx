import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ConnectionBar from '../../../src/features/connections/ConnectionBar.tsx';
import { initialForm } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { ConnectionForm } from '../../../src/shared/siteContracts.ts';
import type { PaneStatus } from '../../../src/shared/paneContracts.ts';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function open(initial: Partial<ConnectionForm> = {}, status: PaneStatus = 'idle', narrow = false) {
  const callbacks = {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onCancelConnect: vi.fn(),
    onSaveSite: vi.fn(),
    onOpenSiteManager: vi.fn(),
    onDismissError: vi.fn(),
  };
  function Form() {
    const [form, onChange] = useState({ ...initialForm, host: 'example', port: '21', ...initial });
    return (
      <>
        <ConnectionBar
          {...callbacks}
          form={form}
          onChange={onChange}
          status={status}
          narrow={narrow}
          connectionVisualState="idle"
          errorMessage="Connection error"
        />
        <output data-testid="form">{JSON.stringify(form)}</output>
      </>
    );
  }
  const view = render(<Form />);
  return {
    ...view,
    callbacks,
    form: () => JSON.parse(screen.getByTestId('form').textContent!) as ConnectionForm,
  };
}

test.each([
  ['21', ''],
  ['', ''],
  ['22', ''],
  ['2121', '2121'],
])('switching protocol empties a default port and keeps a custom one (%s)', (port, expected) => {
  const h = open({ port });
  fireEvent.click(screen.getByRole('button', { name: 'FTP' }));
  fireEvent.click(screen.getByRole('option', { name: 'SFTP' }));
  expect(h.form().protocol).toBe('sftp');
  expect(h.form().port).toBe(expected);
  // An empty port is the default, and the field says which.
  expect(
    screen.getByRole<HTMLInputElement>('textbox', { name: 'connectionBar.fields.port' })
      .placeholder,
  ).toBe('22');
});

test.each(['idle', 'connecting', 'connected'] as const)(
  'connection state %s routes actions without duplicate connects',
  (status) => {
    const h = open({}, status);
    const action =
      status === 'idle' ? 'connect' : status === 'connecting' ? 'cancel' : 'disconnect';
    fireEvent.click(screen.getByRole('button', { name: `connectionBar.connectTooltip.${action}` }));
    expect(h.callbacks.onConnect).toHaveBeenCalledTimes(status === 'idle' ? 1 : 0);
    expect(h.callbacks.onCancelConnect).toHaveBeenCalledTimes(status === 'connecting' ? 1 : 0);
    expect(h.callbacks.onDisconnect).toHaveBeenCalledTimes(status === 'connected' ? 1 : 0);
    expect(
      (screen.getByLabelText('connectionBar.fields.address') as HTMLInputElement).disabled,
    ).toBe(status !== 'idle');
    fireEvent.click(screen.getByRole('button', { name: 'menu.file.saveConnection' }));
    fireEvent.click(screen.getByRole('button', { name: 'menu.file.manageBookmarks' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(h.callbacks.onSaveSite).toHaveBeenCalledOnce();
    expect(h.callbacks.onOpenSiteManager).toHaveBeenCalledOnce();
    expect(h.callbacks.onDismissError).toHaveBeenCalledOnce();
  },
);

test('blank addresses disable connecting and saving until filled', () => {
  const h = open({ host: '' });
  expect(
    (
      screen.getByRole('button', {
        name: 'connectionBar.connectTooltip.connect',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'menu.file.saveConnection' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  for (const [label, value] of [
    ['address', 'host.test'],
    ['port', '2021'],
    ['user', 'alice'],
    ['password', 'secret'],
  ]) {
    fireEvent.change(screen.getByLabelText(`connectionBar.fields.${label}`), { target: { value } });
  }
  expect(h.form()).toMatchObject({
    host: 'host.test',
    port: '2021',
    user: 'alice',
    password: 'secret',
  });
  fireEvent.click(screen.getByRole('button', { name: 'connectionBar.connectTooltip.connect' }));
  expect(h.callbacks.onConnect).toHaveBeenCalledOnce();
});

test('key authentication clears the password and warns for a selected RSA key', async () => {
  const selectKeyFile = vi.fn().mockResolvedValue({ path: 'C:\\keys\\id_rsa', isRsa: true });
  window.api = { fsLocal: { selectKeyFile } } as unknown as Window['api'];
  const h = open({ protocol: 'sftp', password: 'old-secret' });
  fireEvent.click(screen.getByLabelText('connectionBar.authToggle.label'));
  expect(h.form().password).toBe('');
  expect(screen.queryByLabelText('connectionBar.fields.password')).toBeNull();
  fireEvent.change(screen.getByLabelText('connectionBar.fields.passphrase'), {
    target: { value: 'passphrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.keyFile' }));
  await screen.findByLabelText('connectionBar.rsaKeyWarning');
  expect(h.form()).toMatchObject({
    useKeyAuth: true,
    keyPath: 'C:\\keys\\id_rsa',
    keyPassphrase: 'passphrase',
  });
  selectKeyFile.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.keyFile' }));
  await waitFor(() => expect(selectKeyFile).toHaveBeenCalledTimes(2));
  expect(h.form().keyPath).toBe('C:\\keys\\id_rsa');
});

test.each([false, true])(
  'WebDAV distinguishes HTTP authentication permission from certificate validation (narrow: %s)',
  async (narrow) => {
    const selectCaCertFile = vi.fn().mockResolvedValue('C:\\cert.pem');
    window.api = { fsLocal: { selectCaCertFile } } as unknown as Window['api'];
    const h = open({ protocol: 'webdav', webdavUrl: 'http://example/dav' }, 'idle', narrow);
    fireEvent.click(screen.getByLabelText('connectionBar.cleartextToggle.label'));
    expect(h.form().allowCleartextAuth).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.caCertFile' }));
    await waitFor(() => expect(h.form().caCertPath).toBe('C:\\cert.pem'));
    fireEvent.click(screen.getByLabelText('connectionBar.secureToggle.label'));
    expect(h.form().allowInvalidCert).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'siteManagerDialog.fields.caCertFile',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('connectionBar.fields.address'), {
      target: { value: 'https://example/dav' },
    });
    expect(screen.queryByLabelText('connectionBar.cleartextToggle.label')).toBeNull();
    expect(h.form().webdavUrl).toBe('https://example/dav');
  },
);

test('plain FTP carries the unencrypted warning, and an encrypted protocol drops it', () => {
  const { container } = open();
  const warning = () => container.querySelector('[data-tooltip="protocolSelect.insecureWarning"]');
  expect(warning()).not.toBeNull();
  for (const protocol of ['FTPS', 'SFTP']) {
    fireEvent.click(screen.getByRole('button', { name: /^(FTP|FTPS|SFTP)$/ }));
    fireEvent.click(screen.getByRole('option', { name: protocol }));
    expect(warning()).toBeNull();
  }
});
