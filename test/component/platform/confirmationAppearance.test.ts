import { afterEach, expect, test } from 'vitest';
import { installConfirmationAppearance } from '../../../src/platform/confirmationAppearance.ts';
import { COLOR_SCHEMES } from '../../../src/shared/appearance.ts';
import en from '../../../src/i18n/locales/en.json';
import { normalizeSettings } from '../../../src/features/settings/useSettings.ts';

afterEach(() => {
  delete window.__FTPEACH_APPEARANCE__;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.colorScheme;
});

test('confirmations apply the initial snapshot and follow preview and rollback', () => {
  window.__FTPEACH_APPEARANCE__ = { light: true, colorScheme: 'ocean' };
  const dispose = installConfirmationAppearance();
  expect(document.documentElement.dataset).toMatchObject({ theme: 'light', colorScheme: 'ocean' });
  window.__FTPEACH_APPEARANCE__ = { light: false, colorScheme: 'forest' };
  window.dispatchEvent(new Event('ftpeach-appearance'));
  expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', colorScheme: 'forest' });
  window.__FTPEACH_APPEARANCE__ = { light: true, colorScheme: 'ocean' };
  window.dispatchEvent(new Event('ftpeach-appearance'));
  expect(document.documentElement.dataset).toMatchObject({ theme: 'light', colorScheme: 'ocean' });
  dispose();
  window.__FTPEACH_APPEARANCE__ = { light: false, colorScheme: 'peach' };
  window.dispatchEvent(new Event('ftpeach-appearance'));
  expect(document.documentElement.dataset.colorScheme).toBe('ocean');
});

test('old or unknown settings use Peach and valid palettes survive hydration', () => {
  for (const colorScheme of [undefined, null, 3, 'missing']) {
    expect(normalizeSettings({ colorScheme }).interface.colorScheme).toBe('peach');
  }
  for (const colorScheme of [
    'peach',
    'graphite',
    'ocean',
    'forest',
    'dracula',
    'catppuccin',
    'nord',
    'solarized',
    'black',
    'gray',
    'sand',
    'rose',
    'leaves',
    'midnight',
    'plum',
    'ember',
    'clay',
    'cocoa',
    'linen',
    'burgundy',
  ]) {
    expect(normalizeSettings({ colorScheme }).interface.colorScheme).toBe(colorScheme);
  }
});

test('palette names follow color order without changing stored identifiers', () => {
  expect(COLOR_SCHEMES.map((id) => en.settings.colorSchemes[id])).toEqual([
    'Peach',
    'Onyx',
    'Ash',
    'Graphite',
    'Linen',
    'Sand',
    'Cocoa',
    'Ember',
    'Clay',
    'Grass',
    'Forest',
    'Lagoon',
    'Frost',
    'Ocean',
    'Midnight',
    'Bluebell',
    'Orchid',
    'Plum',
    'Burgundy',
    'Rose',
  ]);
  for (const colorScheme of COLOR_SCHEMES) {
    expect(normalizeSettings({ colorScheme }).interface.colorScheme).toBe(colorScheme);
  }
});
