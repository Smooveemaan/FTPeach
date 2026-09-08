import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useAppBootstrap } from '../../../src/app/useAppBootstrap.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

type BootstrapOptions = Parameters<typeof useAppBootstrap>[0];
type SettingsApi = NonNullable<BootstrapOptions['settingsApi']>;
type SitesApi = NonNullable<BootstrapOptions['sitesApi']>;

describe('saved sites refresh', () => {
  test('ignores an older list response that resolves after a newer refresh', async () => {
    const pending: Array<(_sites: ManagedSite[]) => void> = [];
    const resolveListCall = (index: number, sites: ManagedSite[]) => {
      const resolve = pending[index];
      if (!resolve) throw new Error(`list() call #${index} has not been made yet`);
      resolve(sites);
    };
    const sitesApi: SitesApi = {
      list: vi.fn(() => new Promise<ManagedSite[]>((resolve) => pending.push(resolve))),
      save: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true })),
      saveFolder: vi.fn(async () => ({ ok: true })),
      deleteFolder: vi.fn(async () => ({ ok: true })),
      applyLayout: vi.fn(async () => ({ ok: true })),
      hasLegacySecret: vi.fn(async () => false),
      hasPlaintextSecret: vi.fn(async () => false),
      revealSecret: vi.fn(async () => ({ ok: true, value: '' })),
    };
    const settingsApi: SettingsApi = {
      get: vi.fn(async () => ({ language: 'en' })),
      set: vi.fn(async () => ({})),
      revealProxyPassword: vi.fn(async () => null),
    };
    const { result } = renderHook(() =>
      useAppBootstrap({ applySettings: vi.fn(), settingsApi, sitesApi }),
    );

    await act(async () => {
      const latest = result.current.refreshSites();
      resolveListCall(1, [{ id: 'latest', name: 'Latest' }]);
      await latest;
    });
    await act(async () => {
      resolveListCall(0, [{ id: 'stale', name: 'Stale' }]);
    });

    expect(result.current.sites).toEqual([{ id: 'latest', name: 'Latest' }]);
  });
});
