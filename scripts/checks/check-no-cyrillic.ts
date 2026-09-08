import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignoredDirectories = new Set([
  '.git',
  '.local',
  '.tools',
  'node_modules',
  'dist',
  'target',
  // Generated browser reports can contain localized UI text.
  'test-results',
  'playwright-report',
]);
const allowed = new Set([
  path.normalize('src/i18n/index.ts'),
  path.normalize('src/i18n/locales/ru.json'),
  path.normalize('src/i18n/locales/uk.json'),
]);
const violations: string[] = [];

async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(absolute);
      continue;
    }

    const relative = path.normalize(path.relative(root, absolute));
    if (allowed.has(relative)) continue;
    const content = await readFile(absolute);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    if (!/\p{Script=Cyrillic}/u.test(text)) continue;
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/\p{Script=Cyrillic}/u.test(line)) {
        violations.push(`${relative}:${index + 1}`);
      }
    }
  }
}

await scan(root);
assert.equal(
  violations.length,
  0,
  `Cyrillic is allowed only in the Russian and Ukrainian locale files:\n${violations.join('\n')}`,
);
console.log('Cyrillic check passed (Russian and Ukrainian locale files excluded)');
