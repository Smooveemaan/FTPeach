// Code coverage, one report per runner. `npm run coverage` runs the Node unit
// suite and the component suite with coverage and reports both; `--rust`
// reports coverage/rust/lcov.info, written by `npm run rust:coverage`.
//
// The runners count different things (Node: lines of loaded modules; Vitest:
// statements of every production file; LLVM: lines of the compiled crate), so
// their percentages are shown side by side and never added or averaged.
// scripts/coverage/coverage-floors.json holds the per-file floors for the
// modules behind the P0/P1 guarantees; see docs/coverage.md.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ignoredTests } from '../checks/check-ignored-tests.ts';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'coverage');

interface Counts {
  found: number;
  hit: number;
}
interface FileCoverage {
  lines: Counts;
  branches: Counts;
  functions: Counts;
  lineHits?: Map<number, number>;
}
type Report = Map<string, FileCoverage>;
type Suite = 'unit' | 'component' | 'rust';

const empty = (): FileCoverage => ({
  lines: { found: 0, hit: 0 },
  branches: { found: 0, hit: 0 },
  functions: { found: 0, hit: 0 },
});

/** Repository-relative, forward slashes: the key floors and reports share. */
export function normalize(file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(root, file);
  return path.relative(root, absolute).replaceAll('\\', '/');
}

export function parseLcov(text: string): Report {
  const report: Report = new Map();
  let current: FileCoverage | null = null;
  for (const line of text.split(/\r?\n/)) {
    const [key, value = ''] = line.split(/:(.*)/s);
    if (key === 'SF') {
      current = empty();
      report.set(normalize(value), current);
    } else if (key === 'end_of_record') {
      current = null;
    } else if (current && key === 'DA') {
      const [number, hits] = value.split(',').map(Number);
      current.lineHits ??= new Map();
      current.lineHits.set(number!, hits!);
    } else if (current && ['LF', 'LH', 'BRF', 'BRH', 'FNF', 'FNH'].includes(key ?? '')) {
      const metric = key!.startsWith('L')
        ? 'lines'
        : key!.startsWith('B')
          ? 'branches'
          : 'functions';
      current[metric][key!.endsWith('F') ? 'found' : 'hit'] += Number(value);
    }
  }
  return report;
}

interface IstanbulMetric {
  total: number;
  covered: number;
}
type IstanbulSummary = Record<string, Record<'lines' | 'branches' | 'functions', IstanbulMetric>>;

export function parseIstanbulSummary(summary: IstanbulSummary): Report {
  const report: Report = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const counts = (metric: IstanbulMetric): Counts => ({
      found: metric.total,
      hit: metric.covered,
    });
    report.set(normalize(file), {
      lines: counts(metrics.lines),
      branches: counts(metrics.branches),
      functions: counts(metrics.functions),
    });
  }
  return report;
}

function total(report: Report): FileCoverage {
  const sum = empty();
  for (const file of report.values()) {
    for (const metric of ['lines', 'branches', 'functions'] as const) {
      sum[metric].found += file[metric].found;
      sum[metric].hit += file[metric].hit;
    }
  }
  return sum;
}

export const percent = ({ found, hit }: Counts): number =>
  found === 0 ? 100 : (hit / found) * 100;
const shown = (counts: Counts) =>
  counts.found === 0
    ? 'not measured'
    : `${percent(counts).toFixed(2)}% (${counts.hit}/${counts.found})`;

/**
 * Floor failures: a listed file missing from its report, with no measured lines, or below its
 * line floor. No measured lines is a failure, not 100%: the unit report lists every production
 * file the Node suite never loaded with zero lines, and a floored module that stops being
 * loaded must not pass as fully covered.
 */
export function checkFloors(report: Report, floors: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const [file, floor] of Object.entries(floors)) {
    const coverage = report.get(file);
    if (!coverage)
      problems.push(`${file}: not in the report (renamed, deleted or no longer loaded?)`);
    else if (coverage.lines.found === 0)
      problems.push(`${file}: no measured lines (no longer loaded by this suite?)`);
    else if (percent(coverage.lines) < floor)
      problems.push(
        `${file}: lines ${percent(coverage.lines).toFixed(2)}% below its floor of ${floor}%`,
      );
  }
  return problems;
}

/** Intersect zero-context diff hunks with the runner's measured lines. */
export function changedCoverage(report: Report, diffs: Map<string, string>): Report {
  const changed: Report = new Map();
  for (const [file, diff] of diffs) {
    const lines = new Set<number>();
    for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let line = start; line < start + count; line++) lines.add(line);
    }
    if (lines.size === 0) continue;
    const coverage = report.get(file);
    if (!coverage || (!coverage.lineHits && coverage.lines.found > 0))
      throw new Error(`${file}: missing line records for changed-line coverage`);
    const entry = empty();
    for (const line of lines) {
      const hits = coverage.lineHits?.get(line);
      if (hits === undefined) continue; // Deleted lines and non-measured source do not count.
      entry.lines.found++;
      if (hits > 0) entry.lines.hit++;
    }
    if (entry.lines.found > 0) changed.set(file, entry);
  }
  return changed;
}

function productionFiles(): string[] {
  return fs
    .readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isDirectory() &&
        /\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !entry.parentPath.includes('graphify-out'),
    )
    .map((entry) => normalize(path.join(entry.parentPath, entry.name)));
}

/** Runs a Node entry point with this Node, so no shell is involved. */
function run(args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`node ${args.join(' ')} exited with ${result.status ?? result.signal}`);
    process.exit(result.status ?? 1);
  }
}

export function section(suite: Suite, report: Report, notes: string[]): string {
  const sum = total(report);
  const unmeasured =
    suite === 'unit'
      ? [...report]
          .filter(([, file]) => file.lines.found === 0)
          .map(([file]) => file)
          .sort()
      : [];
  return [
    `### ${suite}`,
    '',
    '| Files | Lines | Branches | Functions |',
    '| ---: | ---: | ---: | ---: |',
    `| ${report.size} | ${shown(sum.lines)} | ${shown(sum.branches)} | ${shown(sum.functions)} |`,
    '',
    ...notes.map((note) => `- ${note}`),
    '',
    ...(unmeasured.length === 0
      ? []
      : [
          '<details>',
          '<summary>Files with no measured lines</summary>',
          '',
          '| File | Found lines | Hit lines |',
          '| --- | ---: | ---: |',
          ...unmeasured.map((file) => `| \`${file}\` | 0 | 0 |`),
          '',
          '</details>',
          '',
        ]),
  ].join('\n');
}

function main(): void {
  const rust = process.argv.includes('--rust');
  const floors: Record<Suite, Record<string, number>> = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'coverage-floors.json'), 'utf8'),
  );
  const sections: string[] = [];
  const problems: string[] = [];
  const base = process.env.COVERAGE_DIFF_BASE?.trim();
  // Resolve before running tests. An unavailable base must fail, never skip the gate.
  const baseCommit = base
    ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim()
    : undefined;
  // Without a base nothing compares changed lines; the report says so rather
  // than reading as a pass. CI has none on a first push or a scheduled run.
  if (!baseCommit) {
    sections.push(
      [
        '### Changed lines',
        '',
        'Not checked: COVERAGE_DIFF_BASE is not set, so only the per-file floors apply.',
        '',
      ].join('\n'),
    );
  }

  function checkChanged(suite: Suite, report: Report): void {
    if (!baseCommit) return;
    const diffs = new Map(
      Object.keys(floors[suite]).map((file) => [
        file,
        execFileSync(
          'git',
          [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-color',
            '--unified=0',
            '--inter-hunk-context=0',
            baseCommit,
            '--',
            file,
          ],
          { cwd: root, encoding: 'utf8' },
        ),
      ]),
    );
    const changed = changedCoverage(report, diffs);
    const changedFloors = Object.fromEntries(
      Object.entries(floors[suite]).filter(([file]) => changed.has(file)),
    );
    sections.push(
      [
        `### ${suite}: changed lines`,
        '',
        `Compared with \`${baseCommit}\`; only measured added or modified lines in floored modules count.`,
        '',
        ...(changed.size === 0
          ? ['No measured lines changed in floored modules.']
          : [
              '| File | Changed lines | Floor |',
              '| --- | ---: | ---: |',
              ...[...changed].map(
                ([file, coverage]) =>
                  `| \`${file}\` | ${shown(coverage.lines)} | ${changedFloors[file]}% |`,
              ),
            ]),
        '',
      ].join('\n'),
    );
    problems.push(
      ...checkFloors(changed, changedFloors).map((problem) => `${suite} changed lines: ${problem}`),
    );
  }

  if (rust) {
    const lcov = path.join(out, 'rust', 'lcov.info');
    if (!fs.existsSync(lcov))
      throw new Error(`${lcov} is missing; run npm run rust:coverage first`);
    const report = parseLcov(fs.readFileSync(lcov, 'utf8'));
    // Test files are not production code; inline `#[cfg(test)]` modules still count.
    for (const file of report.keys())
      if (!file.startsWith('src-tauri/src/') || /(^|\/)(tests|\w+_tests)\.rs$/.test(file))
        report.delete(file);
    const ignored = ['src-tauri/src', 'src-tauri/tests']
      .flatMap((dir) =>
        fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true }),
      )
      .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
      .flatMap((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return ignoredTests(normalize(file), fs.readFileSync(file, 'utf8'));
      }).length;
    sections.push(
      section('rust', report, [
        'Windows build of `src-tauri/src` without test files; code behind `cfg(not(windows))` is not compiled, so it is not in the denominator. Branch coverage needs a nightly toolchain and is not measured.',
        `${ignored} \`#[ignore]\` tests (live servers, Docker, second volume, privileges) do not run here; docs/verification-matrix.md lists them and how to run each.`,
      ]),
    );
    problems.push(...checkFloors(report, floors.rust));
    checkChanged('rust', report);
  } else {
    fs.rmSync(path.join(out, 'unit'), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'unit'), { recursive: true });
    run([
      '--experimental-strip-types',
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      '--test-coverage-exclude=src/**/*.d.ts',
      '--test-coverage-exclude=src/graphify-out/**',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/unit/lcov.info',
      '--test-reporter=junit',
      '--test-reporter-destination=coverage/unit/junit.xml',
      '--test',
      'test/unit/**/*.test.ts',
    ]);
    run([
      'node_modules/vitest/vitest.mjs',
      'run',
      '--coverage',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=coverage/component/results.json',
    ]);

    const unit = parseLcov(fs.readFileSync(path.join(out, 'unit', 'lcov.info'), 'utf8'));
    const junit = fs.readFileSync(path.join(out, 'unit', 'junit.xml'), 'utf8');
    const notLoaded = productionFiles().filter((file) => !unit.has(file));
    for (const file of notLoaded) unit.set(file, empty());
    sections.push(
      section('unit', unit, [
        `${notLoaded.length} production files are never loaded by the Node suite; they are listed with 0 found lines, because Node measures only loaded modules. Their share is in the component report.`,
        `Skipped or todo tests: ${junit.match(/<skipped/g)?.length ?? 0}.`,
      ]),
    );
    problems.push(...checkFloors(unit, floors.unit));
    checkChanged('unit', unit);

    const component = parseIstanbulSummary(
      JSON.parse(fs.readFileSync(path.join(out, 'component', 'coverage-summary.json'), 'utf8')),
    );
    const results: { numPendingTests: number; numTodoTests: number } = JSON.parse(
      fs.readFileSync(path.join(out, 'component', 'results.json'), 'utf8'),
    );
    const untouched = [...component.values()].filter(
      (file) => file.lines.found > 0 && file.lines.hit === 0,
    );
    sections.push(
      section('component', component, [
        `Every production file counts, loaded or not: ${untouched.length} files have no line run by any component test.`,
        `Skipped or todo tests: ${results.numPendingTests + results.numTodoTests}.`,
      ]),
    );
    problems.push(...checkFloors(component, floors.component));
    if (baseCommit)
      checkChanged(
        'component',
        parseLcov(fs.readFileSync(path.join(out, 'component', 'lcov.info'), 'utf8')),
      );
  }

  const summary = sections.join('\n');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, rust ? 'rust-summary.md' : 'summary.md'), summary);
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (problems.length > 0) {
    console.error(
      `Coverage floors failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log('Every floored file is at or above its floor.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
