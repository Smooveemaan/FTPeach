import { afterEach, describe, expect, test } from 'vitest';
import { applyInterfaceScale, getInterfaceScale } from '../../../src/platform/interfaceScale.ts';

afterEach(() => {
  document.documentElement.style.removeProperty('--interface-scale');
  delete document.documentElement.dataset.interfaceScale;
});

describe('getInterfaceScale', () => {
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
