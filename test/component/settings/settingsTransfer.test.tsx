import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import SettingsTransferDialog from '../../../src/features/settings/components/SettingsTransferDialog.tsx';
import { useSettingsTransfer } from '../../../src/features/settings/useSettingsTransfer.ts';
import type { SettingsTransferModel } from '../../../src/features/settings/useSettingsTransfer.ts';
import type {
  ExportSettingsResult,
  ImportPreviewResult,
  ImportSettingsResult,
} from '../../../src/platform/api/settings.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const done = { text: 'done', short: 'done' };

function model(overrides: Partial<SettingsTransferModel> = {}) {
  return {
    exportSettings: vi.fn<SettingsTransferModel['exportSettings']>(async () => ({ done })),
    previewImport: vi.fn<SettingsTransferModel['previewImport']>(async () => ({
      hasSecrets: false,
    })),
    applyImport: vi.fn<SettingsTransferModel['applyImport']>(async () => ({
      done,
      warnings: null,
    })),
    discardImport: vi.fn(),
    ...overrides,
  };
}

function renderDialog(mode: 'import' | 'export', transfer = model()) {
  const props = {
    mode,
    transfer,
    sites: [
      { id: 'a', name: 'A', hasPassword: true, hasKeyPassphrase: true },
      { id: 'b', name: 'B', hasPassword: true },
      { id: 'c', name: 'C' },
    ],
    onDone: vi.fn(),
    onVaultUnlockRequired: vi.fn(),
    onClose: vi.fn(),
    initialOptions: { includeSettings: false, includeBookmarks: true, includeLocalPaths: false },
  };
  render(<SettingsTransferDialog {...props} />);
  return props;
}

const button = (name: string) => screen.getByRole('button', { name });
const box = (name: string) => screen.getByRole('checkbox', { name });

for (const mode of ['import', 'export'] as const) {
  test(`the ${mode} form starts from the given scope and runs with what is ticked`, async () => {
    const user = userEvent.setup({ delay: null });
    const transfer = model();
    const props = renderDialog(mode, transfer);
    expect(screen.getByRole('dialog', { name: `${mode}SettingsDialog.title` })).toBeTruthy();
    expect(box(`${mode}SettingsDialog.includeBookmarks`)).toHaveProperty('checked', true);

    const confirm = button(`${mode}SettingsDialog.confirmLabel`);
    await user.click(box(`${mode}SettingsDialog.includeBookmarks`));
    expect(confirm).toHaveProperty('disabled', true);
    await user.click(box(`${mode}SettingsDialog.includeSettings`));
    await user.click(confirm);

    const chosen = { includeSettings: true, includeBookmarks: false, includeLocalPaths: false };
    if (mode === 'export') {
      expect(transfer.exportSettings).toHaveBeenCalledWith(chosen, undefined);
    } else {
      expect(transfer.previewImport).toHaveBeenCalledWith(chosen);
      // A file without passwords is imported at once.
      await waitFor(() => expect(transfer.applyImport).toHaveBeenCalledWith(chosen, null));
    }
    await waitFor(() => expect(props.onDone).toHaveBeenCalledWith(done));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
}

test('an export with the saved passwords needs a long password typed twice', async () => {
  const user = userEvent.setup({ delay: null });
  const transfer = model();
  renderDialog('export', transfer);
  const withPasswords = box('exportSettingsDialog.includePasswords');
  await user.click(box('exportSettingsDialog.includeBookmarks'));
  expect(withPasswords).toHaveProperty('disabled', true);
  await user.click(box('exportSettingsDialog.includeBookmarks'));
  await user.click(withPasswords);
  // Three passwords and one passphrase are saved among the bookmarks.
  expect(screen.getByText('exportSettingsDialog.passwordsCount')).toBeTruthy();

  const confirm = button('exportSettingsDialog.confirmLabel');
  const password = screen.getByLabelText('exportSettingsDialog.exportPassword');
  const again = screen.getByLabelText('exportSettingsDialog.confirmExportPassword');
  await user.type(password, 'short');
  expect(screen.getByText('exportSettingsDialog.passwordTooShort')).toBeTruthy();
  expect(confirm).toHaveProperty('disabled', true);
  await user.clear(password);
  await user.type(password, 'a long export phrase');
  await user.type(again, 'a long export phrase!');
  expect(screen.getByText('exportSettingsDialog.passwordMismatch')).toBeTruthy();
  expect(confirm).toHaveProperty('disabled', true);
  await user.type(again, '{Backspace}');
  // The master password or Windows Hello is asked by the confirmation window.
  expect(screen.queryByLabelText('settings.security.masterPassword')).toBeNull();
  await user.click(confirm);
  expect(transfer.exportSettings).toHaveBeenCalledWith(
    { includeSettings: false, includeBookmarks: true, includeLocalPaths: false },
    { password: 'a long export phrase', skipUnreadable: false },
  );
});

test('bookmarks whose passwords cannot be opened are named, and left out only when asked', async () => {
  const user = userEvent.setup({ delay: null });
  const transfer = model({
    exportSettings: vi
      .fn<SettingsTransferModel['exportSettings']>()
      .mockResolvedValueOnce({ unreadable: ['Old server'] })
      .mockResolvedValueOnce({ done }),
  });
  const props = renderDialog('export', transfer);
  await user.click(box('exportSettingsDialog.includePasswords'));
  for (const field of screen.getAllByLabelText(
    /exportSettingsDialog\.(export|confirmExport)Password/,
  ))
    await user.type(field, 'a long export phrase');
  await user.click(button('exportSettingsDialog.confirmLabel'));

  expect(await screen.findByText('Old server')).toBeTruthy();
  expect(props.onClose).not.toHaveBeenCalled();
  await user.click(button('exportSettingsDialog.exportWithoutThem'));
  expect(transfer.exportSettings).toHaveBeenLastCalledWith(expect.anything(), {
    password: 'a long export phrase',
    skipUnreadable: true,
  });
  await waitFor(() => expect(props.onDone).toHaveBeenCalledWith(done));
});

test('a file with passwords asks for its password and keeps asking until it opens them', async () => {
  const user = userEvent.setup({ delay: null });
  const transfer = model({
    previewImport: vi.fn(async () => ({ hasSecrets: true })),
    applyImport: vi
      .fn<SettingsTransferModel['applyImport']>()
      .mockResolvedValueOnce({ wrongPassword: true })
      .mockResolvedValueOnce({
        done,
        warnings: { scopeMismatches: ['Moved server'], unmatched: [] },
      }),
  });
  const props = renderDialog('import', transfer);
  await user.click(button('importSettingsDialog.confirmLabel'));
  const field = await screen.findByLabelText('importSettingsDialog.filePassword');
  const importWith = button('importSettingsDialog.importWithPasswords');
  expect(importWith).toHaveProperty('disabled', true);

  await user.type(field, 'wrong');
  await user.click(importWith);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'importSettingsDialog.wrongPassword',
  );
  await user.clear(field);
  await user.type(field, 'right{Enter}');
  expect(transfer.applyImport).toHaveBeenLastCalledWith(expect.anything(), 'right');

  // Done, but one bookmark's password stayed behind: the dialog says which.
  expect(await screen.findByText('Moved server')).toBeTruthy();
  expect(screen.getByText('importSettingsDialog.scopeMismatch')).toBeTruthy();
  expect(props.onDone).toHaveBeenCalledWith(done);
  const footer = document.querySelector('.modal-footer') as HTMLElement;
  await user.click(within(footer).getByRole('button', { name: 'common.close' }));
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(transfer.discardImport).not.toHaveBeenCalled();
});

test('a file with passwords can be imported without them, or let go', async () => {
  const user = userEvent.setup({ delay: null });
  const transfer = model({ previewImport: vi.fn(async () => ({ hasSecrets: true })) });
  renderDialog('import', transfer);
  await user.click(button('importSettingsDialog.confirmLabel'));
  await user.click(
    await screen.findByRole('button', { name: 'importSettingsDialog.importWithoutPasswords' }),
  );
  expect(transfer.applyImport).toHaveBeenCalledWith(expect.anything(), null);

  const letGo = model({ previewImport: vi.fn(async () => ({ hasSecrets: true })) });
  document.body.innerHTML = '';
  const props = renderDialog('import', letGo);
  await user.click(button('importSettingsDialog.confirmLabel'));
  await user.click(await screen.findByRole('button', { name: 'common.cancel' }));
  expect(letGo.discardImport).toHaveBeenCalledOnce();
  expect(letGo.applyImport).not.toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalledOnce();
});

test('a locked vault is unlocked first and the import goes on with the same password', async () => {
  const user = userEvent.setup({ delay: null });
  const transfer = model({
    previewImport: vi.fn(async () => ({ hasSecrets: true })),
    applyImport: vi
      .fn<SettingsTransferModel['applyImport']>()
      .mockResolvedValueOnce({ vaultLocked: true })
      .mockResolvedValueOnce({ done, warnings: null }),
  });
  const props = renderDialog('import', transfer);
  await user.click(button('importSettingsDialog.confirmLabel'));
  await user.type(await screen.findByLabelText('importSettingsDialog.filePassword'), 'pw{Enter}');
  await waitFor(() => expect(props.onVaultUnlockRequired).toHaveBeenCalledOnce());
  const [retry] = props.onVaultUnlockRequired.mock.calls[0] as [() => void];
  act(() => retry());
  await waitFor(() => expect(props.onDone).toHaveBeenCalledWith(done));
  expect(transfer.applyImport).toHaveBeenLastCalledWith(expect.anything(), 'pw');
});

const options = { includeSettings: true, includeBookmarks: true, includeLocalPaths: false };

function transfer(results: {
  export?: ExportSettingsResult;
  preview?: ImportPreviewResult;
  import?: ImportSettingsResult;
}) {
  const appApi = {
    exportSettings: vi.fn(async () => results.export ?? { ok: true }),
    importPreview: vi.fn(async () => results.preview ?? { ok: true }),
    importApply: vi.fn(async () => results.import ?? { ok: true }),
    importDiscard: vi.fn(async () => ({ ok: true })),
  };
  const applySettings = vi.fn();
  const refreshSites = vi.fn();
  const reportError = vi.fn();
  const { result } = renderHook(() =>
    useSettingsTransfer({ applySettings, refreshSites, reportError, appApi }),
  );
  return { model: result.current, appApi, applySettings, refreshSites, reportError };
}

test('a cancelled export or import is not an error and has nothing to say', async () => {
  const { model, reportError } = transfer({
    export: { ok: false, canceled: true },
    preview: { ok: false, canceled: true },
  });
  // A confirmation declined is a cancel too, not "Cancelled by user".
  const declined = transfer({
    export: { ok: false, error: 'Operation was cancelled', errorCode: 'cancelled' },
    preview: { ok: false, error: 'Operation was cancelled', errorCode: 'cancelled' },
  });
  await act(async () => {
    for (const { model: each } of [{ model }, declined]) {
      expect(await each.exportSettings(options)).toBeUndefined();
      expect(await each.previewImport(options)).toBeUndefined();
    }
  });
  expect(reportError).not.toHaveBeenCalled();
  expect(declined.reportError).not.toHaveBeenCalled();
});

test('a failed export or import is reported and changes nothing', async () => {
  const { model, reportError, applySettings, refreshSites } = transfer({
    export: { ok: false, error: 'disk full', errorCode: 'storageFull' },
    import: { ok: false, error: 'not a settings file', errorCode: 'invalidInput' },
  });
  await act(async () => {
    expect(await model.exportSettings(options)).toBeUndefined();
    expect(await model.applyImport(options, null)).toBeUndefined();
  });
  expect(reportError).toHaveBeenCalledTimes(2);
  expect(applySettings).not.toHaveBeenCalled();
  expect(refreshSites).not.toHaveBeenCalled();
});

test('a refused import names what was wrong with the file', async () => {
  const { model, reportError } = transfer({
    preview: {
      ok: false,
      error: 'Invalid input',
      errorCode: 'invalidInput',
      diagnosticDetails: 'sites[3]: Host is required\nsites[5]: Port must be between 1 and 65535',
    },
  });
  await act(() => model.previewImport(options));
  // The translated message says the file was refused; the first reason says where.
  expect(reportError).toHaveBeenCalledExactlyOnceWith(
    'errors.importRefused sites[3]: Host is required',
  );
});

test('an import that could not be undone says so first', async () => {
  const { model, reportError } = transfer({
    import: {
      ok: false,
      error: 'Unexpected error',
      errorCode: 'internal',
      diagnosticDetails: 'The import failed and could not be fully undone. sites.json …\ncause',
    },
  });
  await act(() => model.applyImport(options, 'pw'));
  expect(reportError).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('could not be fully undone'),
  );
});

test('a successful import applies the settings, reloads the sites and says what it did', async () => {
  const settings = { theme: 'dark' };
  const { model, appApi, applySettings, refreshSites } = transfer({
    import: { ok: true, settings, sitesAdded: 2, sitesSkipped: 1, secretsSaved: 1 },
  });
  let outcome: unknown;
  await act(async () => {
    outcome = await model.applyImport(options, 'pw');
  });
  expect(appApi.importApply).toHaveBeenCalledWith('pw');
  expect(applySettings).toHaveBeenCalledWith(settings);
  expect(refreshSites).toHaveBeenCalledOnce();
  expect(outcome).toEqual({
    done: {
      text: 'statusBar.imported · statusBar.importAdded · statusBar.transferPasswords · statusBar.importSkipped',
      short:
        'statusBar.importedShort · statusBar.importAdded · statusBar.transferPasswords · statusBar.importSkippedShort',
    },
    warnings: null,
  });
});

test('passwords filled in for bookmarks already here are something new', async () => {
  const { model, refreshSites } = transfer({
    import: { ok: true, sitesAdded: 0, sitesSkipped: 3, flagsRestored: 2, unmatched: ['Twin'] },
  });
  let outcome: unknown;
  await act(async () => {
    outcome = await model.applyImport(options, 'pw');
  });
  expect(refreshSites).toHaveBeenCalledOnce();
  expect(outcome).toEqual({
    done: {
      text: 'statusBar.transferPasswords · statusBar.importSkipped',
      short: 'statusBar.importedShort · statusBar.transferPasswords · statusBar.importSkippedShort',
    },
    warnings: { scopeMismatches: [], unmatched: ['Twin'] },
  });
});

test('the dialog answers a wrong file password, a locked vault and unreadable passwords', async () => {
  const wrong = transfer({ import: { ok: false, error: 'x', errorCode: 'authFailed' } });
  const locked = transfer({
    import: { ok: false, error: 'x', errorCode: 'vaultLocked' },
    export: { ok: false, error: 'x', errorCode: 'vaultLocked' },
  });
  const unreadable = transfer({
    export: {
      ok: false,
      error: 'x',
      errorCode: 'savedSecretUnreadable',
      diagnosticDetails: 'Old server\nOlder server',
    },
  });
  const secrets = { password: 'a long export phrase', skipUnreadable: false };
  await act(async () => {
    expect(await wrong.model.applyImport(options, 'pw')).toEqual({ wrongPassword: true });
    expect(await locked.model.applyImport(options, 'pw')).toEqual({ vaultLocked: true });
    expect(await locked.model.exportSettings(options, secrets)).toEqual({ vaultLocked: true });
    expect(await unreadable.model.exportSettings(options, secrets)).toEqual({
      unreadable: ['Old server', 'Older server'],
    });
  });
  for (const { reportError } of [wrong, locked, unreadable])
    expect(reportError).not.toHaveBeenCalled();
  expect(unreadable.appApi.exportSettings).toHaveBeenCalledWith(options, secrets);
});

test('an export says what it wrote and how many passwords it sealed', async () => {
  const { model } = transfer({ export: { ok: true, secrets: 4 } });
  await act(async () => {
    expect(await model.exportSettings(options)).toEqual({
      done: {
        text: 'statusBar.exported · statusBar.transferPasswords',
        short: 'statusBar.exportedShort · statusBar.transferPasswords',
      },
    });
  });
});

test('an import that brought in only duplicates says there was nothing new', async () => {
  const { model, refreshSites } = transfer({
    import: { ok: true, sitesAdded: 0, sitesSkipped: 3 },
  });
  await act(async () => {
    expect(await model.applyImport(options, null)).toEqual({
      done: {
        text: 'statusBar.importNothingNew · statusBar.importSkipped',
        short: 'statusBar.importNothingNewShort · statusBar.importSkippedShort',
      },
      warnings: null,
    });
  });
  expect(refreshSites).not.toHaveBeenCalled();
});
