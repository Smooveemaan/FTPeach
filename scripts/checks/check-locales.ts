import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

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

  const categories = new Intl.PluralRules(fileName.replace(/\.json$/, '')).resolvedOptions()
    .pluralCategories;
  for (const key of reference.keys()) {
    if (!key.endsWith('_other')) continue;
    const base = key.slice(0, -6);
    for (const category of categories) {
      const pluralKey = base + '_' + category;
      const value = locale.get(pluralKey);
      if (value === undefined || !value.trim()) {
        problems.push(fileName + ': missing or empty plural ' + pluralKey);
      } else if (placeholders(value).join('|') !== referencePlaceholders.get(key)) {
        problems.push(fileName + ': placeholders differ for ' + pluralKey);
      }
    }
  }

  for (const key of locale.keys()) {
    if (!reference.has(key) && !isLocaleSpecificPluralKey(key, reference)) {
      problems.push(`${fileName}: unexpected key ${key}`);
    }
  }
}

// Inspect literal translation calls, including ones with English default values.
async function checkSource(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkSource(file);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isTranslation =
          (ts.isIdentifier(callee) && callee.text === 't') ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === 't');
        const key = node.arguments[0];
        if (
          isTranslation &&
          key &&
          ts.isStringLiteral(key) &&
          !reference.has(key.text) &&
          !reference.has(key.text + '_other')
        ) {
          const location = source.getLineAndCharacterOfPosition(key.getStart(source));
          problems.push(file + ':' + (location.line + 1) + ': unknown translation key ' + key.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await checkSource(path.resolve('src'));

if (problems.length > 0) {
  console.error(
    `Locale validation failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `${files.length - 1} translations match ${referenceLocale}; source keys, placeholders and plural forms are valid.`,
  );
}
