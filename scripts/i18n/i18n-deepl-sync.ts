#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, '..', '..', 'src', 'i18n', 'locales');
const sourceLocale = 'en';

// FTPeach locale filename -> DeepL target_lang code.
const LOCALE_TO_DEEPL = {
  ru: 'RU',
  de: 'DE',
  es: 'ES',
  fr: 'FR',
  it: 'IT',
  ja: 'JA',
  ko: 'KO',
  pl: 'PL',
  uk: 'UK',
  'pt-BR': 'PT-BR',
  tr: 'TR',
  'zh-Hans': 'ZH-HANS',
  'zh-Hant': 'ZH-HANT',
  hi: 'HI',
  ar: 'AR',
  vi: 'VI',
  id: 'ID',
  nl: 'NL',
  cs: 'CS',
  hu: 'HU',
  el: 'EL',
  sv: 'SV',
  ro: 'RO',
  da: 'DA',
  th: 'TH',
  he: 'HE',
} as const;

type Locale = keyof typeof LOCALE_TO_DEEPL;
type TranslationTree = { [key: string]: string | TranslationTree };
type FlatTranslations = Record<string, string>;

interface CliOptions {
  langs: string[] | null;
  keys: Set<string> | null;
  force: boolean;
  dryRun: boolean;
  sourceFallback: boolean;
  key: string | null;
}

interface DeepLResponse {
  translations: Array<{ text: string }>;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    langs: null,
    keys: null,
    force: false,
    dryRun: false,
    sourceFallback: false,
    key: null,
  };
  for (const arg of argv) {
    if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--source-fallback') opts.sourceFallback = true;
    else if (arg.startsWith('--langs=')) opts.langs = arg.slice(8).split(',').filter(Boolean);
    else if (arg.startsWith('--keys='))
      opts.keys = new Set(arg.slice(7).split(',').filter(Boolean));
    else if (arg.startsWith('--key=')) opts.key = arg.slice(6);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run i18n:sync -- [options]

  --langs=de,fr          Limit target locales (default: all except English)
  --keys=key1,key2       Limit translation keys
  --force               Replace existing translations
  --dry-run             Preview changes without API calls or file writes
  --source-fallback     Fill selected keys with English without API calls
  --key=KEY             DeepL API key (default: DEEPL_API_KEY)
  --help, -h            Show this help`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function flatten(obj: TranslationTree, prefix = '', out: FlatTranslations = {}): FlatTranslations {
  for (const [k, v] of Object.entries(obj)) {
    const path_ = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out[path_] = v;
    } else {
      flatten(v, path_, out);
    }
  }
  return out;
}

function setTranslation(tree: TranslationTree, key: string, value: string): void {
  const segments = key.split('.');
  let current = tree;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || typeof child === 'string') current[segment] = {};
    current = current[segment] as TranslationTree;
  }
  current[segments.at(-1)!] = value;
}

function protectPlaceholders(text: string): string {
  return text.replace(/\{\{\s*[\w.]+\s*\}\}/g, (m) => `<x>${m}</x>`);
}

function unprotectPlaceholders(text: string): string {
  return text.replace(/<\/?x>/g, '');
}

async function translateBatch(
  texts: readonly string[],
  targetLang: (typeof LOCALE_TO_DEEPL)[Locale],
  apiKey: string,
): Promise<string[]> {
  const host = apiKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const body = new URLSearchParams();
  for (const t of texts) body.append('text', protectPlaceholders(t));
  body.append('target_lang', targetLang);
  body.append('source_lang', 'EN');
  body.append('tag_handling', 'xml');
  body.append('ignore_tags', 'x');

  const res = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepL API error ${res.status} ${res.statusText}: ${detail}`);
  }

  const data = (await res.json()) as DeepLResponse;
  return data.translations.map((t) => unprotectPlaceholders(t.text));
}

const BATCH_SIZE = 50;

function isSupportedLocale(locale: string): locale is Locale {
  return Object.hasOwn(LOCALE_TO_DEEPL, locale);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const sourcePath = path.join(localesDir, `${sourceLocale}.json`);
  const sourceJson = JSON.parse(readFileSync(sourcePath, 'utf8')) as TranslationTree;
  const sourceFlat = flatten(sourceJson);

  const availableLocales = readdirSync(localesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((l) => l !== sourceLocale);

  const targetLocales = opts.langs ?? availableLocales;
  for (const locale of targetLocales) {
    if (!isSupportedLocale(locale)) {
      console.error(
        `No DeepL target_lang mapping for locale "${locale}" — add it to LOCALE_TO_DEEPL in this script.`,
      );
      process.exit(1);
    }
  }

  const apiKey = opts.key ?? process.env.DEEPL_API_KEY;
  if (!opts.dryRun && !opts.sourceFallback && !apiKey) {
    console.error(
      'Missing DeepL API key. Set DEEPL_API_KEY or pass --key=xxxxx (get one at deepl.com/pro-api).',
    );
    process.exit(1);
  }

  let anyChanges = false;

  for (const locale of targetLocales) {
    if (!isSupportedLocale(locale)) continue;
    const filePath = path.join(localesDir, `${locale}.json`);
    const targetJson = JSON.parse(readFileSync(filePath, 'utf8')) as TranslationTree;
    const targetFlat = flatten(targetJson);

    // Entries rather than keys: the text travels with its key, so nothing
    // downstream has to defend against a key missing from the source.
    const entriesToTranslate = Object.entries(sourceFlat).filter(([k]) => {
      if (opts.keys && !opts.keys.has(k)) return false;
      if (opts.force) return true;
      return !Object.prototype.hasOwnProperty.call(targetFlat, k) || targetFlat[k] === '';
    });

    if (entriesToTranslate.length === 0) {
      console.log(`[${locale}] up to date, nothing to translate.`);
      continue;
    }

    console.log(`[${locale}] ${entriesToTranslate.length} key(s) to translate:`);
    for (const [k, text] of entriesToTranslate) console.log(`  ${k}: ${JSON.stringify(text)}`);

    if (opts.dryRun) continue;
    if (!opts.sourceFallback && !apiKey) {
      throw new Error('DeepL API key disappeared after validation.');
    }

    anyChanges = true;
    const overrides: FlatTranslations = {};
    const targetLang = LOCALE_TO_DEEPL[locale];

    if (opts.sourceFallback) {
      for (const [key, text] of entriesToTranslate) overrides[key] = text;
    }

    for (let i = 0; !opts.sourceFallback && i < entriesToTranslate.length; i += BATCH_SIZE) {
      if (!apiKey) throw new Error('DeepL API key disappeared after validation.');
      const batch = entriesToTranslate.slice(i, i + BATCH_SIZE);
      const translated = await translateBatch(
        batch.map(([, text]) => text),
        targetLang,
        apiKey,
      );
      batch.forEach(([k], idx) => {
        const value = translated[idx];
        if (value === undefined) {
          throw new Error(
            `DeepL returned ${translated.length} translation(s) for ${batch.length} text(s).`,
          );
        }
        overrides[k] = value;
      });
    }

    const rebuilt = structuredClone(targetJson);
    for (const [key, value] of Object.entries(overrides)) setTranslation(rebuilt, key, value);
    writeFileSync(filePath, JSON.stringify(rebuilt, null, 2) + '\n', 'utf8');
    console.log(
      `[${locale}] wrote ${entriesToTranslate.length} translation(s) to ${path.relative(process.cwd(), filePath)}`,
    );
  }

  if (opts.dryRun) {
    console.log('\nDry run — no API calls made, no files written.');
  } else if (!anyChanges) {
    console.log('\nAll locales already in sync.');
  } else {
    console.log(
      '\nDone. Review the diffs before committing — machine translations need a human pass.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
