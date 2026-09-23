import { expect, test, vi } from 'vitest';

// A locale chunk that cannot be loaded, the way a missing or corrupt bundle fails.
vi.mock('../../../src/i18n/locales/th.json', () => {
  throw new Error('chunk failed');
});

const { default: i18n, changeLanguage } = await import('../../../src/i18n/index.ts');

const settled = () => ({
  language: i18n.language,
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
});

test('the language chosen last wins even when the one before it loads slower', async () => {
  // Arabic has to be fetched; English is bundled and lands first.
  const slow = changeLanguage('ar');
  const fast = changeLanguage('en');
  await expect(fast).resolves.toBe('en');
  await expect(slow).resolves.toBeNull();
  expect(settled()).toEqual({ language: 'en', lang: 'en', dir: 'ltr' });
});

test('switching to a right-to-left language sets dir with the translation', async () => {
  await changeLanguage('en');
  await expect(changeLanguage('he')).resolves.toBe('he');
  expect(settled()).toEqual({ language: 'he', lang: 'he', dir: 'rtl' });
  await changeLanguage('en');
  expect(settled()).toEqual({ language: 'en', lang: 'en', dir: 'ltr' });
});

test('a locale that fails to load keeps the current language', async () => {
  await changeLanguage('en');
  await expect(changeLanguage('th')).rejects.toThrow();
  expect(settled()).toEqual({ language: 'en', lang: 'en', dir: 'ltr' });

  // Overtaken by a newer choice, the same failure is nobody's concern.
  const failed = changeLanguage('th');
  await changeLanguage('en');
  await expect(failed).resolves.toBeNull();
});
