import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkFloors,
  changedCoverage,
  parseIstanbulSummary,
  parseLcov,
  percent,
  rustTestOnlyLines,
  section,
} from '../../../scripts/coverage/coverage.ts';

test('an invalid diff base fails the command before running the suites', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('../../../scripts/coverage/coverage.ts', import.meta.url)),
    ],
    { env: { ...process.env, COVERAGE_DIFF_BASE: 'invalid..base' }, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rev-parse/);
  assert.equal(result.stdout, '');
});

test('changed-line floor catches an untested addition hidden by whole-file coverage', () => {
  const file = 'src/shared/lang.ts';
  const report = parseLcov(`SF:${file}\nDA:100,0\nLF:100\nLH:99\nend_of_record\n`);
  const floors = { [file]: 98 };
  assert.deepEqual(checkFloors(report, floors), []);
  const changed = changedCoverage(report, new Map([[file, '@@ -99,0 +100 @@\n+untested();']]));
  assert.deepEqual(changed.get(file)!.lines, { found: 1, hit: 0 });
  assert.match(checkFloors(changed, floors)[0]!, /0\.00% below its floor of 98%/);
});

test('code only the tests compile is left out of changed Rust lines', () => {
  const source = [
    'pub fn shipped() -> u8 {', // 1
    '    1', // 2
    '}', // 3
    '', // 4
    '#[cfg(test)]', // 5
    'mod tests {', // 6
    '    fn skipped_without_privilege() {}', // 7
    '}', // 8
  ].join('\n');
  assert.deepEqual([...rustTestOnlyLines(source)], [5, 6, 7, 8]);

  const file = 'src-tauri/src/local_fs/example.rs';
  const report = parseLcov(`SF:${file}\nDA:2,0\nDA:7,0\nLF:2\nLH:0\nend_of_record\n`);
  const diff = '@@ -1,0 +2 @@\n+    1\n@@ -6,0 +7 @@\n+    fn skipped_without_privilege() {}';
  // A test line that never ran counts against the floor unless it is left out.
  assert.deepEqual(changedCoverage(report, new Map([[file, diff]])).get(file)!.lines, {
    found: 2,
    hit: 0,
  });
  const tests = rustTestOnlyLines(source);
  assert.deepEqual(changedCoverage(report, new Map([[file, diff]]), () => tests).get(file)!.lines, {
    found: 1,
    hit: 0,
  });
});

test('changed coverage counts only measured new-side lines across diff hunks', () => {
  const file = 'src-tauri/src/runtime/shutdown.rs';
  const report = parseLcov(
    `SF:${file}\nDA:2,3,checksum\nDA:4,0\nDA:9,1\nDA:12,0\nLF:4\nLH:2\nend_of_record\n`,
  );
  const diff = [
    '@@ -2 +2,3 @@ fn stop() {',
    '-old();',
    '+covered();',
    '+// Not a measured line.',
    '+untested();',
    '@@ -8 +9 @@',
    '-old();',
    '+covered();',
    '@@ -12,2 +12,0 @@',
    '-deleted();',
    '-deleted();',
  ].join('\r\n');
  const changed = changedCoverage(report, new Map([[file, diff]]));
  assert.deepEqual(changed.get(file)!.lines, { found: 3, hit: 2 });
  assert.deepEqual(checkFloors(changed, { [file]: 60 }), []);
  assert.match(checkFloors(changed, { [file]: 70 })[0]!, /66\.67% below/);
});

test('comments, deletions and unchanged files have no changed-line denominator', () => {
  const file = 'src/a.ts';
  const report = parseLcov(`SF:${file}\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`);
  for (const diff of ['', '@@ -1,0 +2 @@\n+// Comment', '@@ -2 +1,0 @@\n-deleted();']) {
    assert.equal(changedCoverage(report, new Map([[file, diff]])).size, 0);
  }
});

test('new and renamed files count all measured added lines', () => {
  const file = 'src/new.ts';
  const report = parseLcov(`SF:${file}\nDA:1,1\nDA:3,0\nLF:2\nLH:1\nend_of_record\n`);
  const changed = changedCoverage(report, new Map([[file, '@@ -0,0 +1,3 @@\n+code']]));
  assert.deepEqual(changed.get(file)!.lines, { found: 2, hit: 1 });
});

test('missing LCOV line records cannot silently bypass changed-line floors', () => {
  const diffs = new Map([['src/a.ts', '@@ -1 +1 @@\n+changed();']]);
  assert.throws(() => changedCoverage(parseLcov(''), diffs), /missing line records/);
  assert.throws(
    () => changedCoverage(parseLcov('SF:src/a.ts\nLF:1\nLH:1\nend_of_record'), diffs),
    /missing line records/,
  );
});

test('unit summary lists unmeasured files without adding them to the denominator', () => {
  const report = parseLcov(
    'SF:src/loaded.ts\nLF:4\nLH:3\nend_of_record\n' +
      'SF:src/z.tsx\nLF:0\nLH:0\nend_of_record\n' +
      'SF:src/a.ts\nLF:0\nLH:0\nend_of_record\n',
  );
  const summary = section('unit', report, ['Skipped or todo tests: 0.']);
  assert.match(summary, /\| 3 \| 75\.00% \(3\/4\)/);
  assert.match(summary, /\| `src\/a.ts` \| 0 \| 0 \|\n\| `src\/z.tsx` \| 0 \| 0 \|/);
  assert.doesNotMatch(summary, /`src\/loaded.ts`/);
  assert.match(summary, /Skipped or todo tests: 0\./);
  assert.doesNotMatch(section('component', report, []), /<details>/);
  assert.doesNotMatch(section('rust', report, []), /<details>/);
  assert.doesNotMatch(section('unit', parseLcov(''), []), /<details>/);
});

test('lcov records become per-file counts under repository-relative paths', () => {
  const report = parseLcov(
    [
      'SF:src\\shared\\movePolicy.ts',
      'FNF:2',
      'FNH:1',
      'BRF:4',
      'BRH:3',
      'LF:10',
      'LH:9',
      'end_of_record',
    ].join('\n'),
  );
  assert.deepEqual(report.get('src/shared/movePolicy.ts'), {
    lines: { found: 10, hit: 9 },
    branches: { found: 4, hit: 3 },
    functions: { found: 2, hit: 1 },
  });
});

test('an istanbul summary drops its total and keeps each file', () => {
  const metric = { total: 4, covered: 1, skipped: 0, pct: 25 };
  const report = parseIstanbulSummary({
    total: { lines: metric, branches: metric, functions: metric },
    'src/a.ts': { lines: metric, branches: metric, functions: metric },
  });
  assert.deepEqual([...report.keys()], ['src/a.ts']);
  assert.equal(percent(report.get('src/a.ts')!.lines), 25);
});

test('a floored file fails when it drops below its floor or leaves the report', () => {
  const report = parseLcov('SF:src/a.ts\nLF:4\nLH:3\nend_of_record\n');
  assert.deepEqual(checkFloors(report, { 'src/a.ts': 75 }), []);
  assert.match(checkFloors(report, { 'src/a.ts': 80 })[0]!, /75\.00% below its floor of 80%/);
  assert.match(checkFloors(report, { 'src/gone.ts': 1 })[0]!, /not in the report/);
});

test('a floored file with no measured lines fails instead of counting as 100%', () => {
  // The unit report lists modules the Node suite never loaded with zero lines.
  const report = parseLcov('');
  report.set('src/platform/shutdownPersistence.ts', {
    lines: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
  });
  assert.match(
    checkFloors(report, { 'src/platform/shutdownPersistence.ts': 98 })[0]!,
    /no measured lines/,
  );
});
