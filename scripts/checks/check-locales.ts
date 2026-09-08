import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const localeDirectory = path.resolve('src/i18n/locales');
const referenceLocale = 'en.json';

type FlatLocale = Map<string, string>;

function flatten(value: unknown, prefix = '', output: FlatLocale = new Map()): FlatLocale {
  if (typeof value === 'string') {
    output.set(prefix, value);
    return output;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object or string at ${prefix || '<root>'}.`);
  }

  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .sort();
}

function isLocaleSpecificPluralKey(key: string, reference: FlatLocale): boolean {
  const baseKey = key.replace(/_(zero|one|two|few|many|other)$/, '');
  return baseKey !== key && (reference.has(`${baseKey}_one`) || reference.has(`${baseKey}_other`));
}

async function loadLocale(fileName: string): Promise<FlatLocale> {
  const source = await readFile(path.join(localeDirectory, fileName), 'utf8');
  return flatten(JSON.parse(source) as unknown);
}

const files = (await readdir(localeDirectory))
  .filter((fileName) => fileName.endsWith('.json'))
  .sort();
const reference = await loadLocale(referenceLocale);
const referencePlaceholders = new Map(
  [...reference].map(([key, value]) => [key, placeholders(value).join('|')]),
);
const problems: string[] = [];

for (const fileName of files) {
  if (fileName === referenceLocale) continue;
  const locale = await loadLocale(fileName);

  for (const [key, expectedPlaceholders] of referencePlaceholders) {
    const value = locale.get(key);
    if (value === undefined) {
      problems.push(`${fileName}: missing key ${key}`);
    } else if (!value.trim()) {
      problems.push(`${fileName}: empty translation for ${key}`);
    } else if (placeholders(value).join('|') !== expectedPlaceholders) {
      problems.push(`${fileName}: placeholders differ for ${key}`);
    }
  }

  for (const key of locale.keys()) {
    if (!reference.has(key) && !isLocaleSpecificPluralKey(key, reference)) {
      problems.push(`${fileName}: unexpected key ${key}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    `Locale validation failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log(`${files.length - 1} translations match ${referenceLocale} keys and placeholders.`);
}
