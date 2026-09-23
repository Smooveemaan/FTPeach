import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The rule is about what the repository publishes, so the files come from git:
// tracked ones plus new ones not yet added, minus whatever .gitignore excludes.
// Walking the disk instead made every ignored local output (build reports,
// graphify, assistant notes) a failure unless it was listed here by hand.
const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean);
// Third-party sources FTPeach only patches; their text is not ours.
const ignoredDirectories = new Set(['vendor']);
const allowed = new Set([
  path.normalize('src/i18n/index.ts'),
  path.normalize('src/i18n/locales/ru.json'),
  path.normalize('src/i18n/locales/uk.json'),
]);
const violations: string[] = [];

for (const file of files) {
  const relative = path.normalize(file);
  if (allowed.has(relative)) continue;
  if (file.split('/').some((segment) => ignoredDirectories.has(segment))) continue;
  let content: Buffer;
  try {
    content = await readFile(path.join(root, file));
  } catch (error) {
    // A tracked file deleted in the working tree has nothing left to check.
    if ((error as { code?: string }).code === 'ENOENT') continue;
    throw error;
  }
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

assert.equal(
  violations.length,
  0,
  `Cyrillic is allowed only in the Russian and Ukrainian locale files:\n${violations.join('\n')}`,
);
console.log(
  `Cyrillic check passed on ${files.length} repository file(s) (Russian and Ukrainian locale files excluded)`,
);
