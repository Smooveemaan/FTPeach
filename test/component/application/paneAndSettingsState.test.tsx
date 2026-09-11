import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { usePaneTabs } from '../../../src/features/file-browser/panes/usePaneTabs.ts';
import { useSettings } from '../../../src/features/settings/useSettings.ts';

describe('pane and settings state', () => {
  test('keeps pane state isolated between tabs and sessions', () => {
    let id = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    );
    const { result } = renderHook(() => usePaneTabs());
    act(() => result.current.updatePane('a', { path: '/first', selected: new Set(['one']) }));
    act(() => {
      result.current.setTabs((tabs) => {
        const [first] = tabs;
        if (!first) throw new Error('expected the initial tab');
        return [
          ...tabs,
          {
            ...first,
            id: '00000000-0000-4000-8000-000000000002',
            panes: {
              a: { ...first.panes.a, path: '/second', selected: new Set() },
              b: { ...first.panes.b },
            },
          },
        ];
      });
      result.current.setActiveTabId('00000000-0000-4000-8000-000000000002');
    });
    expect(result.current.panes.a.path).toBe('/second');
    act(() => result.current.updatePane('a', { selected: new Set(['two']) }));
    act(() => result.current.setActiveTabId('00000000-0000-4000-8000-000000000001'));
    expect(result.current.panes.a).toMatchObject({ path: '/first', selected: new Set(['one']) });
  });

  test('previews settings locally and persists only on explicit save', async () => {
    const settingsApi = { set: vi.fn(async () => ({ proxyPasswordSet: true })) };
    const logApi = { setFileLogging: vi.fn() };
    const { result } = renderHook(() => useSettings({ settingsApi, logApi }));
    act(() =>
      result.current.applySettingsDialogPatch({ theme: 'dark', logEnabled: true, unknown: 1 }),
    );
    expect(logApi.setFileLogging).not.toHaveBeenCalled();
    expect(result.current.settings.interface.theme).toBe('dark');
    expect((result.current.settings as unknown as Record<string, unknown>).unknown).toBeUndefined();
    expect(settingsApi.set).not.toHaveBeenCalled();
    await act(() => result.current.persistSettingsDialogPatch({ theme: 'dark' }));
    expect(settingsApi.set).toHaveBeenCalledWith({ theme: 'dark' });
    expect(result.current.settings.connection.proxyPasswordSet).toBe(true);
  });
});
