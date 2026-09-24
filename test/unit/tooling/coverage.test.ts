import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkFloors,
  parseIstanbulSummary,
  parseLcov,
  percent,
} from '../../../scripts/coverage/coverage.ts';

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
