import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useSettings } from '../../../src/features/settings/useSettings.ts';
import { useApplicationSettings } from '../../../src/app/useApplicationSettings.ts';
import { api } from '../../../src/platform/api/index.ts';
import type { SettingsSetResult } from '../../../src/platform/api/settings.ts';

vi.mock('../../../src/platform/api/index.ts', () => ({ api: { settings: { set: vi.fn() } } }));

test('StrictMode column changes coalesce and newer revisions wait for the older write', async () => {
  vi.useFakeTimers();
  const set = vi.mocked(api.settings.set);
  let finish: (_value: SettingsSetResult) => void = () => {};
  set.mockResolvedValue({});
  set.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(
    () => {
      const settings = useSettings();
      return useApplicationSettings({
        layout: settings.settings.layout,
        update: settings.update,
        applySettings: settings.applySettings,
        hydrateLayout: () => {},
      });
    },
    { wrapper: StrictMode },
  );
  try {
    act(() => {
      result.current.changeLocalColumnWidths('a')({ name: 100 });
      result.current.changeLocalColumnWidths('a')({ name: 120 });
      result.current.changeLocalColumns('b')(['name', 'size']);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toMatchObject({
      localColumnWidths: { a: { name: 120 } },
      localColumns: { b: ['name', 'size'] },
    });
    act(() => {
      result.current.changeLocalColumnWidths('a')({ name: 180 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({});
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1]?.[0]).toMatchObject({ localColumnWidths: { a: { name: 180 } } });
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
