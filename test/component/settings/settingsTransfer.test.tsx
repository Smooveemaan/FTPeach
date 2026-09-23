import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import SettingsTransferDialog from '../../../src/features/settings/components/SettingsTransferDialog.tsx';
import { useSettingsTransfer } from '../../../src/features/settings/useSettingsTransfer.ts';
import type {
  ExportSettingsResult,
  ImportSettingsResult,
} from '../../../src/platform/api/settings.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

for (const mode of ['import', 'export'] as const) {
  test(`the ${mode} form starts from the given scope and confirms what is ticked`, async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <SettingsTransferDialog
        mode={mode}
        onConfirm={onConfirm}
        onClose={onClose}
        initialOptions={{
          includeSettings: false,
          includeBookmarks: false,
          includeLocalPaths: true,
        }}
      />,
    );
    expect(screen.getByRole('dialog', { name: `${mode}SettingsDialog.title` })).toBeTruthy();
    const box = (part: string) =>
      screen.getByRole('checkbox', { name: `${mode}SettingsDialog.${part}` });
    expect(box('includeLocalPaths')).toHaveProperty('checked', true);
    expect(box('includeBookmarks')).toHaveProperty('checked', false);

    const confirm = screen.getByRole('button', { name: `${mode}SettingsDialog.confirmLabel` });
    await user.click(box('includeLocalPaths'));
    expect(confirm).toHaveProperty('disabled', true);

    await user.click(box('includeSettings'));
    await user.click(box('includeBookmarks'));
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      includeSettings: true,
      includeBookmarks: true,
      includeLocalPaths: false,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
}

const options = { includeSettings: true, includeBookmarks: true, includeLocalPaths: false };

function transfer(results: { export?: ExportSettingsResult; import?: ImportSettingsResult }) {
  const appApi = {
    exportSettings: vi.fn(async () => results.export ?? { ok: true }),
    importSettings: vi.fn(async () => results.import ?? { ok: true }),
  };
  const applySettings = vi.fn();
  const refreshSites = vi.fn();
  const reportError = vi.fn();
  const { result } = renderHook(() =>
    useSettingsTransfer({ applySettings, refreshSites, reportError, appApi }),
  );
  return { model: result.current, appApi, applySettings, refreshSites, reportError };
}

test('a cancelled export or import is not an error', async () => {
  const { model, reportError } = transfer({
    export: { ok: false, canceled: true },
    import: { ok: false, canceled: true },
  });
  await act(async () => {
    expect(await model.exportSettings(options)).toBe(false);
    expect(await model.importSettings(options)).toBeUndefined();
  });
  expect(reportError).not.toHaveBeenCalled();
});

test('a failed export or import is reported and changes nothing', async () => {
  const { model, reportError, applySettings, refreshSites } = transfer({
    export: { ok: false, error: 'disk full', errorCode: 'storageFull' },
    import: { ok: false, error: 'not a settings file', errorCode: 'invalidInput' },
  });
  await act(async () => {
    expect(await model.exportSettings(options)).toBe(false);
    expect(await model.importSettings(options)).toBeUndefined();
  });
  expect(reportError).toHaveBeenCalledTimes(2);
  expect(applySettings).not.toHaveBeenCalled();
  expect(refreshSites).not.toHaveBeenCalled();
});

test('a successful import applies the settings and reloads the sites it added', async () => {
  const settings = { theme: 'dark' };
  const { model, appApi, applySettings, refreshSites } = transfer({
    import: { ok: true, settings, sitesAdded: 2, sitesSkipped: 1 },
  });
  let summary: unknown;
  await act(async () => {
    summary = await model.importSettings(options);
  });
  expect(appApi.importSettings).toHaveBeenCalledWith(options);
  expect(applySettings).toHaveBeenCalledWith(settings);
  expect(refreshSites).toHaveBeenCalledOnce();
  expect(summary).toEqual({ sitesAdded: 2, sitesSkipped: 1 });
});
