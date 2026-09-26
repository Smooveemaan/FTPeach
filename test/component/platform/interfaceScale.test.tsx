import { afterEach, describe, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { applyInterfaceScale, getInterfaceScale } from '../../../src/platform/interfaceScale.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  document.documentElement.style.removeProperty('--interface-scale');
  delete document.documentElement.dataset.interfaceScale;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('getInterfaceScale', () => {
  test('sends the user preference without multiplying by the browser DPR', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.stubGlobal('devicePixelRatio', 1.875);
    await applyInterfaceScale(125);
    expect(invoke).toHaveBeenCalledWith('app_set_interface_scale', { scale: 1.25 });
    expect(getInterfaceScale()).toBe(1);
  });

  test('reports a native scaling failure to the caller', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.mocked(invoke).mockRejectedValueOnce(new Error('scale failed'));
    await expect(applyInterfaceScale(100)).rejects.toThrow('scale failed');
  });
  test('defaults to 1 when --interface-scale is unset', () => {
    expect(getInterfaceScale()).toBe(1);
  });

  test.each([80, 90, 100, 110, 125, 150])(
    'keeps layout coordinates unscaled at %s%%',
    async (percent) => {
      await applyInterfaceScale(percent);
      expect(getInterfaceScale()).toBe(1);
      expect(document.documentElement.dataset.interfaceScale).toBe(String(percent));
    },
  );

  test('falls back to 1 for invalid or non-positive values', () => {
    document.documentElement.style.setProperty('--interface-scale', 'not-a-number');
    expect(getInterfaceScale()).toBe(1);
    document.documentElement.style.setProperty('--interface-scale', '0');
    expect(getInterfaceScale()).toBe(1);
    document.documentElement.style.setProperty('--interface-scale', '-1');
    expect(getInterfaceScale()).toBe(1);
  });
});
