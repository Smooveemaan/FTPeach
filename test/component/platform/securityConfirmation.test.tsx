import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import SecurityConfirmation from '../../../src/platform/SecurityConfirmation.tsx';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  respond: vi.fn(),
  close: vi.fn(),
  setSize: vi.fn(),
  language: vi.fn(),
  i18n: {},
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: mocks.close, setSize: mocks.setSize }),
}));
vi.mock('../../../src/i18n/index.ts', () => ({
  matchSupportedLanguage: (locale: string) => (locale === 'en' ? locale : null),
  changeLanguage: mocks.language,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: mocks.i18n,
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ' ' + JSON.stringify(values) : ''}`,
  }),
}));

const prefix = 'plugin:sensitive|';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.respond.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.setSize.mockResolvedValue(undefined);
  mocks.language.mockResolvedValue(undefined);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

async function open(overrides: Record<string, unknown> = {}) {
  mocks.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === `${prefix}sensitive_confirmation_prompt`)
      return Promise.resolve({
        kind: 'vaultReset',
        locale: 'en',
        requiresReauthentication: false,
        ...overrides,
      });
    if (command === `${prefix}respond_sensitive_confirmation`) return mocks.respond(args);
    return Promise.resolve();
  });
  const view = render(<SecurityConfirmation requestId="request-1" />);
  await screen.findByText('securityConfirmation.title');
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(`${prefix}sensitive_confirmation_ready`, {
      requestId: 'request-1',
    }),
  );
  return view;
}
const approve = () => screen.getByRole('button', { name: /\.approve/ }) as HTMLButtonElement;

test('loads the request, falls back to English, sizes the window and reports ready', async () => {
  await open({ locale: 'unknown-locale' });
  expect(mocks.invoke).toHaveBeenCalledWith(`${prefix}sensitive_confirmation_prompt`, {
    requestId: 'request-1',
  });
  expect(mocks.language).toHaveBeenCalledWith('en');
  expect(mocks.setSize).toHaveBeenCalledTimes(2);
  expect(approve().disabled).toBe(false);
});

test('a missing prompt closes the window without authorizing anything', async () => {
  mocks.invoke.mockRejectedValue(new Error('expired request'));
  render(<SecurityConfirmation requestId="expired" />);
  expect(
    (screen.getByRole('button', { name: 'securityConfirmation.allow' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  expect(mocks.respond).not.toHaveBeenCalled();
});

test('confirmation phrase must match exactly before a click or Enter can approve', async () => {
  await open({ confirmationPhrase: 'RESET' });
  const phrase = screen.getByPlaceholderText('RESET');
  fireEvent.change(phrase, { target: { value: 'reset' } });
  fireEvent.keyDown(phrase, { key: 'Enter' });
  fireEvent.click(approve());
  expect(mocks.respond).not.toHaveBeenCalled();
  fireEvent.change(phrase, { target: { value: 'RESET' } });
  fireEvent.keyDown(phrase, { key: 'Enter' });
  await waitFor(() =>
    expect(mocks.respond).toHaveBeenCalledWith({
      requestId: 'request-1',
      approved: true,
      masterPassword: null,
      useSystemUnlock: false,
    }),
  );
  fireEvent.click(approve());
  expect(mocks.respond).toHaveBeenCalledOnce();
});

test.each(['password', 'phrase'])(
  'Enter in the %s field cannot bypass the other requirement',
  async (field) => {
    await open({ confirmationPhrase: 'RESET', requiresReauthentication: true });
    const phrase = screen.getByPlaceholderText('RESET');
    const password = screen.getByLabelText('settings.security.masterPassword');
    const filled = field === 'password' ? password : phrase;
    fireEvent.change(filled, { target: { value: field === 'password' ? 'secret' : 'RESET' } });
    expect(approve().disabled).toBe(true);
    fireEvent.keyDown(filled, { key: 'Enter' });
    expect(mocks.respond).not.toHaveBeenCalled();
    fireEvent.change(field === 'password' ? phrase : password, {
      target: { value: field === 'password' ? 'RESET' : 'secret' },
    });
    fireEvent.click(approve());
    await waitFor(() =>
      expect(mocks.respond).toHaveBeenCalledWith({
        requestId: 'request-1',
        approved: true,
        masterPassword: 'secret',
        useSystemUnlock: false,
      }),
    );
  },
);

test('with Windows Hello on, an empty password confirms through Hello', async () => {
  await open({ requiresReauthentication: true, systemUnlock: true });
  expect(screen.getByText('securityConfirmation.systemUnlockHint')).toBeTruthy();
  expect(approve().disabled).toBe(false);
  fireEvent.click(approve());
  await waitFor(() =>
    expect(mocks.respond).toHaveBeenCalledWith({
      requestId: 'request-1',
      approved: true,
      masterPassword: '',
      useSystemUnlock: true,
    }),
  );
});

test('failed reauthentication clears the password and allows a corrected retry', async () => {
  mocks.respond.mockRejectedValueOnce(new Error('wrong password'));
  await open({ requiresReauthentication: true });
  const password = screen.getByLabelText('settings.security.masterPassword') as HTMLInputElement;
  fireEvent.change(password, { target: { value: 'wrong' } });
  fireEvent.keyDown(password, { key: 'Enter' });
  await screen.findByText('siteManagerDialog.revealFailed');
  expect(password.value).toBe('');
  expect(password.getAttribute('aria-invalid')).toBe('true');
  expect(approve().disabled).toBe(true);
  expect(mocks.close).not.toHaveBeenCalled();
  fireEvent.change(password, { target: { value: 'correct' } });
  expect(screen.queryByText('siteManagerDialog.revealFailed')).toBeNull();
  fireEvent.click(approve());
  await waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(2));
  expect(password.value).toBe('');
});

test.each([0, 1])(
  'cancel control %s never sends a typed password or requires a phrase',
  async (index) => {
    await open({ requiresReauthentication: true, confirmationPhrase: 'RESET' });
    fireEvent.change(screen.getByLabelText('settings.security.masterPassword'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'common.cancel' })[index]!);
    await waitFor(() =>
      expect(mocks.respond).toHaveBeenCalledWith({
        requestId: 'request-1',
        approved: false,
        masterPassword: null,
        useSystemUnlock: false,
      }),
    );
  },
);

test('a failed response without reauthentication closes the window', async () => {
  mocks.respond.mockRejectedValueOnce(new Error('expired'));
  await open();
  fireEvent.click(approve());
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
});

test.each([null, 'SHA256:old'])(
  'host-key confirmation shows the actual and pinned fingerprints (%s)',
  async (expected) => {
    const { container } = await open({
      kind: 'trustHostKey',
      target: 'sftp.example',
      hostKey: { expected, actual: 'SHA256:new' },
    });
    expect(container.textContent).toContain('SHA256:new');
    expect(container.textContent).toContain(
      expected ? 'trustHostKeyChanged.message' : 'trustHostKeyFirst.message',
    );
    if (expected) expect(container.textContent).toContain(expected);
  },
);

test.each([0, 30])(
  'weakening security describes every changed protection (%s minutes)',
  async (minutes) => {
    const { container } = await open({
      kind: 'weakenSecuritySettings',
      securityChanges: {
        strictHostKeyCheck: false,
        showSecurityConfirmations: false,
        vaultAutoLockMinutes: minutes,
      },
    });
    expect(container.textContent).toContain('strictHostKeyOff');
    expect(container.textContent).toContain('confirmationsOff');
    expect(container.textContent).toContain(minutes ? 'autoLockMinutes' : 'autoLockNever');
  },
);

test.each(['transferSecret', 'openWithApplication'])(
  'secret transfer warning identifies both recipients (%s)',
  async (kind) => {
    const { container } = await open({
      kind,
      target: 'remote.txt',
      localName: 'local.txt',
      application: 'editor.exe',
      secretTransfer: { from: 'source', to: 'destination', lessSecure: true },
    });
    for (const text of [
      'remote.txt',
      'local.txt',
      'editor.exe',
      'source',
      'destination',
      'transferLessSecure',
    ]) {
      expect(container.textContent).toContain(text);
    }
  },
);

test('unmount during native resize never reports a detached window as ready', async () => {
  let finish!: () => void;
  mocks.setSize.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.invoke.mockResolvedValue({
    kind: 'vaultReset',
    locale: 'en',
    requiresReauthentication: false,
  });
  const { unmount } = render(<SecurityConfirmation requestId="gone" />);
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalled());
  unmount();
  await act(async () => finish());
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    `${prefix}sensitive_confirmation_ready`,
    expect.anything(),
  );
});
