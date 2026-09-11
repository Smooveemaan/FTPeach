import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import i18n, {
  changeLanguage,
  loadLanguage,
  SUPPORTED_LANGUAGES,
} from '../../../src/i18n/index.ts';
import { formatBytes, formatBytesPair, formatSpeed } from '../../../src/shared/format.ts';
import { isolate } from '../../../src/shared/bidi.ts';
import { isTransferNameConflict } from '../../../src/features/transfers/nameConflict.ts';
import { joinRemotePath, joinLocalPath } from '../../../src/shared/paths.ts';
// Imported from the module rather than the feature's index.ts: this suite runs
// under node --test, which has no JSX loader, and the index also exports panes.
import { parentRemotePath, remoteCrumbs } from '../../../src/features/file-browser/remotePath.ts';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('formatBytes handles missing/invalid input', () => {
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(NaN), '—');
});

test('formatBytes stays in bytes below 1024', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes crosses unit boundaries', () => {
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 1024), '1.0 TB');
});

test('formatBytes drops the decimal once the value reaches double digits', () => {
  assert.equal(formatBytes(10 * 1024), '10 KB');
});

test('formatBytes caps at TB instead of inventing a further unit', () => {
  const huge = 1024 * 1024 * 1024 * 1024 * 2048;
  assert.match(formatBytes(huge), /TB$/);
});

test('formatSpeed keeps calculated byte rates compact', () => {
  assert.equal(formatSpeed(0), '0 B/s');
  assert.equal(formatSpeed(0.000007171230398), '<1 B/s');
  assert.equal(formatSpeed(136.768408212), '137 B/s');
  assert.equal(formatSpeed(1536), '1.5 KB/s');
  assert.equal(formatSpeed(Infinity), '—');
});

test('byte pairs share the total unit and precision at every boundary', () => {
  assert.deepEqual(formatBytesPair(512, 0), { current: '512 B', total: '' });
  assert.deepEqual(formatBytesPair(100, 512), { current: '100 B', total: '512 B' });
  for (const [power, unit] of ['KB', 'MB', 'GB', 'TB'].entries()) {
    const total = 1024 ** (power + 1);
    assert.deepEqual(formatBytesPair(total / 2, total), {
      current: `0.5 ${unit}`,
      total: `1.0 ${unit}`,
    });
    assert.deepEqual(formatBytesPair(total * 5, total * 10), {
      current: `5 ${unit}`,
      total: `10 ${unit}`,
    });
  }
});

test('byte pair units follow language changes without stale translations', async () => {
  assert.equal(formatBytesPair(512, 1024).total, '1.0 KB');
  await changeLanguage('ru');
  assert.equal(formatBytesPair(512, 1024).total, '1.0 \u041a\u0411');
  await changeLanguage('en');
  assert.equal(formatBytesPair(512, 1024).total, '1.0 KB');
});

test('formatting supports a secondary Unicode locale', async () => {
  await changeLanguage('ru');

  assert.equal(formatBytes(1024), '1.0 \u041a\u0411');
  assert.equal(
    remoteCrumbs('/a')[0]?.label,
    '\u041a\u043e\u0440\u043d\u0435\u0432\u0430\u044f \u043f\u0430\u043f\u043a\u0430',
  );
});

test('every supported locale translates the secret persistence warning', async () => {
  for (const { value: locale } of SUPPORTED_LANGUAGES) {
    await loadLanguage(locale);
    const message = i18n.getResource(locale, 'translation', 'secretNotPersistedNotice.message');
    assert.equal(typeof message, 'string', `${locale} is missing the warning translation`);
    assert.notEqual(message.trim(), '', `${locale} has an empty warning translation`);
  }
});

test('every supported locale resolves the transferred column', async () => {
  for (const { value: locale } of SUPPORTED_LANGUAGES) {
    await loadLanguage(locale);
    const label = i18n.getFixedT(locale)('transferQueue.columns.transferred');
    assert.equal(typeof label, 'string', `${locale} cannot resolve the transferred column`);
    assert.notEqual(label.trim(), '', `${locale} has an empty transferred column`);
    assert.notEqual(label, 'transferQueue.columns.transferred', `${locale} returns the key`);
  }
});

test('every supported locale translates the About links', async () => {
  const keys = ['legalInformation', 'sourceCode', 'reportIssue'];
  for (const { value: locale } of SUPPORTED_LANGUAGES) {
    await loadLanguage(locale);
    for (const key of keys) {
      const label = i18n.getResource(locale, 'translation', `aboutDialog.${key}`);
      assert.equal(typeof label, 'string', `${locale} is missing aboutDialog.${key}`);
      assert.notEqual(label.trim(), '', `${locale} has an empty aboutDialog.${key}`);
    }
  }
});

test('every supported locale translates the project support menu item', async () => {
  for (const { value: locale } of SUPPORTED_LANGUAGES) {
    await loadLanguage(locale);
    const label = i18n.getResource(locale, 'translation', 'menu.help.supportProject');
    assert.equal(typeof label, 'string', `${locale} is missing menu.help.supportProject`);
    assert.notEqual(label.trim(), '', `${locale} has an empty menu.help.supportProject`);
  }
});

test('folder transfers merge matching directories but keep real conflicts', () => {
  const dir = { name: 'pub', isDirectory: true };
  const file = { name: 'pub', isDirectory: false };
  assert.equal(isTransferNameConflict(dir, undefined), false);
  assert.equal(isTransferNameConflict(dir, dir), false);
  assert.equal(isTransferNameConflict(file, file), true);
  assert.equal(isTransferNameConflict(dir, file), true);
  assert.equal(isTransferNameConflict(file, dir), true);
});

test('joinRemotePath from root', () => {
  assert.equal(joinRemotePath('/', 'file.txt'), '/file.txt');
  assert.equal(joinRemotePath('', 'file.txt'), '/file.txt');
});

test('joinRemotePath from a nested folder, trailing slash tolerated', () => {
  assert.equal(joinRemotePath('/a/b', 'file.txt'), '/a/b/file.txt');
  assert.equal(joinRemotePath('/a/b/', 'file.txt'), '/a/b/file.txt');
});

test('joinRemotePath preserves generated safe segments and exactly one boundary slash', () => {
  const alphabet = ['a', 'Z', '0', '-', '_', ' ', 'é', '文件', '🙂'];
  for (let seed = 0; seed < 500; seed += 1) {
    let value = seed;
    const parts = [];
    for (let depth = 0; depth < 1 + (seed % 6); depth += 1) {
      let segment = '';
      for (let length = 0; length < 1 + ((seed + depth) % 8); length += 1) {
        value = (value * 1664525 + 1013904223) >>> 0;
        segment += alphabet[value % alphabet.length];
      }
      parts.push(segment);
    }
    const base = `/${parts.slice(0, -1).join('/')}${seed % 2 ? '/' : ''}`;
    const name = parts.at(-1);
    assert.ok(name);
    const joined = joinRemotePath(base, name);

    assert.equal(joined.startsWith('/'), true);
    assert.equal(joined.endsWith(name), true);
    assert.equal(joined, `/${parts.join('/')}`);
    assert.equal(joined.includes('//'), false);
  }
});

test('joinLocalPath adds a backslash only when missing', () => {
  assert.equal(joinLocalPath('C:\\Users\\me', 'file.txt'), 'C:\\Users\\me\\file.txt');
  assert.equal(joinLocalPath('C:\\Users\\me\\', 'file.txt'), 'C:\\Users\\me\\file.txt');
});

test('parentRemotePath at/near root', () => {
  assert.equal(parentRemotePath('/'), '/');
  assert.equal(parentRemotePath(''), '/');
  assert.equal(parentRemotePath('/a'), '/');
});

test('parentRemotePath one level up from a nested folder', () => {
  assert.equal(parentRemotePath('/a/b/c'), '/a/b');
});

test('remoteCrumbs root has no bare "/" crumb', () => {
  const crumbs = remoteCrumbs('/');
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0]?.path, '/');
  assert.equal(crumbs[0]?.icon, 'database');
});

test('remoteCrumbs builds one crumb per path segment', () => {
  const crumbs = remoteCrumbs('/a/b');
  assert.deepEqual(
    crumbs.map((c) => c.path),
    ['/', '/a', '/a/b'],
  );
  assert.deepEqual(
    crumbs.map((c) => c.label),
    ['Root folder', 'a', 'b'],
  );
});

test('isolate wraps a name in the isolate pair, leaving the name itself intact', () => {
  const wrapped = isolate('تقرير.txt');

  assert.equal(wrapped.codePointAt(0), 0x2068);
  assert.equal(wrapped.codePointAt(wrapped.length - 1), 0x2069);
  assert.equal(wrapped.slice(1, -1), 'تقرير.txt');
});

test('an isolated name keeps the punctuation of its sentence on the sentence side', () => {
  // What the isolates buy: the RTL run can no longer pull the trailing "?"
  // leftwards past the English words, because it ends at the closing isolate.
  const sentence = `Delete ${isolate('تقرير')}?`;

  assert.equal(sentence.indexOf('?'), sentence.length - 1);
  assert.equal(sentence.codePointAt(sentence.length - 2), 0x2069);
});
