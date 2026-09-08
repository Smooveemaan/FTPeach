import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { matchSupportedLanguage, detectSystemLanguage } from '../../../src/i18n/index.ts';
import SETTINGS_DEFAULTS from '../../../src/shared/settingsDefaults.ts';

const realNavigator = globalThis.navigator;
afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: realNavigator,
    configurable: true,
  });
});
function stubNavigator(value: Pick<Navigator, 'language' | 'languages'>): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
}

test('matchSupportedLanguage matches an exact supported tag case-insensitively', () => {
  assert.equal(matchSupportedLanguage('EN'), 'en');
  assert.equal(matchSupportedLanguage('pt-BR'), 'pt-BR');
  assert.equal(matchSupportedLanguage('zh-Hans'), 'zh-Hans');
  assert.equal(matchSupportedLanguage('zh-Hant'), 'zh-Hant');
  assert.equal(matchSupportedLanguage('HI-in'), 'hi');
});

test('matchSupportedLanguage falls back to the primary subtag for composite tags', () => {
  // No exact "pt-PT"/"zh-CN" entry — both should resolve to the one variant
  // we actually ship for that language family.
  assert.equal(matchSupportedLanguage('pt-PT'), 'pt-BR');
  assert.equal(matchSupportedLanguage('zh-CN'), 'zh-Hans');
  assert.equal(matchSupportedLanguage('zh-SG'), 'zh-Hans');
  assert.equal(matchSupportedLanguage('zh-TW'), 'zh-Hant');
  assert.equal(matchSupportedLanguage('zh-HK'), 'zh-Hant');
  assert.equal(matchSupportedLanguage('en-GB'), 'en');
  assert.equal(matchSupportedLanguage('en_US'), 'en');
  assert.equal(matchSupportedLanguage('ar-EG'), 'ar');
  assert.equal(matchSupportedLanguage('he-IL'), 'he');
});

test('matchSupportedLanguage returns null for unsupported languages', () => {
  assert.equal(matchSupportedLanguage('fi-FI'), null);
  assert.equal(matchSupportedLanguage(''), null);
  assert.equal(matchSupportedLanguage(null), null);
});

test('detectSystemLanguage prefers navigator.languages, most-preferred first', () => {
  stubNavigator({ languages: ['fi-FI', 'pt-PT'], language: 'en-US' });
  assert.equal(detectSystemLanguage(), 'pt-BR');
});

test('detectSystemLanguage falls back to navigator.language without navigator.languages', () => {
  stubNavigator({ languages: [], language: 'zh-CN' });
  assert.equal(detectSystemLanguage(), 'zh-Hans');
});

test('detectSystemLanguage falls back to the settings default when nothing matches', () => {
  stubNavigator({ languages: ['fi-FI'], language: 'fi-FI' });
  assert.equal(detectSystemLanguage(), SETTINGS_DEFAULTS.language);
});
