import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import SETTINGS_DEFAULTS from '../shared/settingsDefaults.ts';
import en from './locales/en.json' with { type: 'json' };

// Native names shown in SettingsDialog's LanguageSelect dropdown —
// SUPPORTED_LANGUAGES order there drives the dropdown's option order.
export const SUPPORTED_LANGUAGES = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'it', label: 'Italiano' },
  { value: 'zh-Hans', label: '中文（简体）' },
  { value: 'zh-Hant', label: '中文（繁體）' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'pl', label: 'Polski' },
  { value: 'uk', label: 'Українська' },
  { value: 'ar', label: 'العربية' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'cs', label: 'Čeština' },
  { value: 'hu', label: 'Magyar' },
  { value: 'el', label: 'Ελληνικά' },
  { value: 'sv', label: 'Svenska' },
  { value: 'ro', label: 'Română' },
  { value: 'da', label: 'Dansk' },
  { value: 'th', label: 'ไทย' },
  { value: 'he', label: 'עברית' },
] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['value'];

type TranslationResource = typeof en;
type LocaleModule = { default: TranslationResource };

// Node's ESM loader requires `with: { type: 'json' }`; Vite's dev server wants
// the opposite for a *dynamic* import, mis-serving `*.json?import` as
// text/javascript (rejected by the browser's MIME check) when it's present.
// Only Node runs these loaders outside Vite (see test/utils.test.ts), so gate
// on it — specifiers stay literal per entry so Vite can still chunk each
// translation separately.
const isNodeRuntime = typeof process !== 'undefined' && !!process.versions.node;
const jsonImportAttributes = isNodeRuntime ? { with: { type: 'json' as const } } : undefined;

// Keep locale imports explicit so an unsupported value can never influence a module path.
// Vite emits each translation as an independent chunk instead of putting every language on
// the startup path. English stays eager because it is the fallback and first-paint language.
const LOCALE_LOADERS: Record<Exclude<SupportedLanguage, 'en'>, () => Promise<LocaleModule>> = {
  ru: () => import('./locales/ru.json', jsonImportAttributes),
  es: () => import('./locales/es.json', jsonImportAttributes),
  fr: () => import('./locales/fr.json', jsonImportAttributes),
  de: () => import('./locales/de.json', jsonImportAttributes),
  'pt-BR': () => import('./locales/pt-BR.json', jsonImportAttributes),
  it: () => import('./locales/it.json', jsonImportAttributes),
  'zh-Hans': () => import('./locales/zh-Hans.json', jsonImportAttributes),
  'zh-Hant': () => import('./locales/zh-Hant.json', jsonImportAttributes),
  hi: () => import('./locales/hi.json', jsonImportAttributes),
  ja: () => import('./locales/ja.json', jsonImportAttributes),
  ko: () => import('./locales/ko.json', jsonImportAttributes),
  tr: () => import('./locales/tr.json', jsonImportAttributes),
  pl: () => import('./locales/pl.json', jsonImportAttributes),
  uk: () => import('./locales/uk.json', jsonImportAttributes),
  ar: () => import('./locales/ar.json', jsonImportAttributes),
  vi: () => import('./locales/vi.json', jsonImportAttributes),
  id: () => import('./locales/id.json', jsonImportAttributes),
  nl: () => import('./locales/nl.json', jsonImportAttributes),
  cs: () => import('./locales/cs.json', jsonImportAttributes),
  hu: () => import('./locales/hu.json', jsonImportAttributes),
  el: () => import('./locales/el.json', jsonImportAttributes),
  sv: () => import('./locales/sv.json', jsonImportAttributes),
  ro: () => import('./locales/ro.json', jsonImportAttributes),
  da: () => import('./locales/da.json', jsonImportAttributes),
  th: () => import('./locales/th.json', jsonImportAttributes),
  he: () => import('./locales/he.json', jsonImportAttributes),
};

const pendingLocaleLoads = new Map<SupportedLanguage, Promise<void>>();

export async function loadLanguage(language: SupportedLanguage): Promise<void> {
  if (i18n.hasResourceBundle(language, 'translation')) return;
  const existing = pendingLocaleLoads.get(language);
  if (existing) return existing;
  const loader = language === 'en' ? null : LOCALE_LOADERS[language];
  if (!loader) return;
  const pending = loader()
    .then(({ default: translation }) => {
      i18n.addResourceBundle(language, 'translation', translation, true, true);
    })
    .finally(() => pendingLocaleLoads.delete(language));
  pendingLocaleLoads.set(language, pending);
  return pending;
}

export async function changeLanguage(language: string): Promise<SupportedLanguage> {
  const supported = matchSupportedLanguage(language) ?? 'en';
  await loadLanguage(supported);
  await i18n.changeLanguage(supported);
  return supported;
}

const INTL_LOCALES = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  'pt-BR': 'pt-BR',
  it: 'it-IT',
  'zh-Hans': 'zh-Hans',
  'zh-Hant': 'zh-Hant',
  hi: 'hi-IN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  tr: 'tr-TR',
  pl: 'pl-PL',
  uk: 'uk-UA',
  ar: 'ar-SA',
  vi: 'vi-VN',
  id: 'id-ID',
  nl: 'nl-NL',
  cs: 'cs-CZ',
  hu: 'hu-HU',
  el: 'el-GR',
  sv: 'sv-SE',
  ro: 'ro-RO',
  da: 'da-DK',
  th: 'th-TH',
  he: 'he-IL',
};

export function intlLocale(lng: string): string {
  return INTL_LOCALES[lng as keyof typeof INTL_LOCALES] || INTL_LOCALES.en;
}

function primarySubtag(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? '';
}

export function matchSupportedLanguage(rawLocale?: string | null): SupportedLanguage | null {
  if (!rawLocale) return null;
  const normalized = rawLocale.toLowerCase().replace(/_/g, '-');
  const exact = SUPPORTED_LANGUAGES.find((l) => l.value.toLowerCase() === normalized);
  if (exact) return exact.value;
  if (/^zh-(tw|hk|mo)(-|$)/.test(normalized)) return 'zh-Hant';
  if (/^zh-(cn|sg|my)(-|$)/.test(normalized)) return 'zh-Hans';
  const primary = primarySubtag(normalized);
  const byPrimary = SUPPORTED_LANGUAGES.find((l) => primarySubtag(l.value) === primary);
  return byPrimary ? byPrimary.value : null;
}

export function detectSystemLanguage(): SupportedLanguage {
  const candidates =
    typeof navigator !== 'undefined' && navigator.languages.length
      ? navigator.languages
      : typeof navigator !== 'undefined' && navigator.language
        ? [navigator.language]
        : [];
  for (const candidate of candidates) {
    const match = matchSupportedLanguage(candidate);
    if (match) return match;
  }
  return SETTINGS_DEFAULTS.language as SupportedLanguage;
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  })
  // Runs at module load, before there is an error banner to write to — and a
  // failed i18n init is precisely the state in which a translated message
  // could not be produced anyway.
  .catch((error: unknown) => console.error('i18n initialization failed', error));

export default i18n;
