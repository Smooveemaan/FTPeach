// Copy-paste detection per area, each with its own denominator. One jscpd run
// over everything mixed locale JSON (tens of thousands of lines that never
// repeat as code) into the frontend figure and Rust tests into the Rust one,
// so neither percentage said anything about the code it was named after.
//
// Areas: frontend TypeScript/TSX, CSS, Rust production and Rust tests. Locale
// JSON is not measured. Rust tests are both the `tests.rs`/`*_tests.rs` files
// and every `#[cfg(test)]` item inside production files, which is cut out of
// the production copy (line numbers kept) and measured with the tests.
//
// The gate is absolute: an area fails when its duplicated lines grow past the
// committed baseline. A deliberate increase, or a decrease worth keeping,
// updates `duplication-baseline.json` in the same change.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTestFile, splitInlineTests } from './rust-source.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baselinePath = path.join(projectRoot, 'scripts', 'checks', 'duplication-baseline.json');
const outputDir = path.join(projectRoot, 'duplication-report');
const MIN_TOKENS = 60;
const FORMAT_EXTENSIONS: Record<string, string[]> = {
  'typescript,tsx': ['.ts', '.tsx'],
  css: ['.css'],
  rust: ['.rs'],
};

export interface AreaStats {
  sources: number;
  lines: number;
  duplicatedLines: number;
  clones: number;
}

function listFiles(directory: string, keep: (_file: string) => boolean): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(keep);
}

/** Writes the production and test halves of the crate's Rust sources. */
function stageRust(stage: string): { production: string; tests: string } {
  const production = path.join(stage, 'rust-production');
  const tests = path.join(stage, 'rust-tests');
  const crate = path.join(projectRoot, 'src-tauri');
  const sources = [
    ...listFiles(path.join(crate, 'src'), (file) => file.endsWith('.rs')),
    ...listFiles(path.join(crate, 'tests'), (file) => file.endsWith('.rs')),
  ];
  for (const file of sources) {
    const relative = path.relative(crate, file);
    const source = readFileSync(file, 'utf8');
    const integration = relative.startsWith(`tests${path.sep}`);
    const halves =
      integration || isTestFile(file)
        ? { production: '', tests: source }
        : splitInlineTests(source);
    for (const [root, text] of [
      [production, halves.production],
      [tests, halves.tests],
    ] as const) {
      if (!text.trim()) continue;
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    }
  }
  return { production, tests };
}

function runJscpd(name: string, target: string, format: string, ignore: string[] = []): AreaStats {
  const output = path.join(outputDir, name);
  const cli = path.join(projectRoot, 'node_modules', 'jscpd', 'run-jscpd.js');
  const result = spawnSync(
    process.execPath,
    [
      cli,
      target,
      '--format',
      format,
      '--min-tokens',
      String(MIN_TOKENS),
      '--reporters',
      'json',
      '--output',
      output,
      '--silent',
      '--no-tips',
      ...ignore.flatMap((pattern) => ['--ignore', pattern]),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`jscpd failed for ${name}:\n${result.stderr}`);
  const report = JSON.parse(readFileSync(path.join(output, 'jscpd-report.json'), 'utf8')) as {
    statistics: { total: AreaStats };
  };
  const { sources, duplicatedLines, clones } = report.statistics.total;
  // jscpd counts every line, the blanked halves of split Rust files included;
  // the share is taken against lines that hold code.
  const extensions = FORMAT_EXTENSIONS[format]!;
  const lines = listFiles(target, (file) => extensions.some((ext) => file.endsWith(ext)))
    .filter((file) => !file.includes(`${path.sep}graphify-out${path.sep}`))
    .reduce(
      (total, file) =>
        total +
        readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.trim()).length,
      0,
    );
  return { sources, lines, duplicatedLines, clones };
}

function main() {
  rmSync(outputDir, { recursive: true, force: true });
  const stage = path.join(outputDir, 'stage');
  const rust = stageRust(stage);
  const version = (
    JSON.parse(
      readFileSync(path.join(projectRoot, 'node_modules', 'jscpd', 'package.json'), 'utf8'),
    ) as { version: string }
  ).version;
  const src = path.join(projectRoot, 'src');
  const ignoreGenerated = ['**/graphify-out/**'];
  const measured: Record<string, AreaStats> = {
    'frontend-ts': runJscpd('frontend-ts', src, 'typescript,tsx', ignoreGenerated),
    css: runJscpd('css', src, 'css', ignoreGenerated),
    'rust-production': runJscpd('rust-production', rust.production, 'rust'),
    'rust-tests': runJscpd('rust-tests', rust.tests, 'rust'),
  };
  rmSync(stage, { recursive: true, force: true });

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    detector: string;
    minTokens: number;
    areas: Record<string, AreaStats>;
  };
  const violations: string[] = [];
  if (baseline.detector !== `jscpd ${version}` || baseline.minTokens !== MIN_TOKENS) {
    violations.push(
      `the baseline was taken with ${baseline.detector}, ${baseline.minTokens} tokens; this run is jscpd ${version}, ${MIN_TOKENS} tokens — measure a new baseline`,
    );
  }
  const rows: string[] = [];
  for (const [area, now] of Object.entries(measured)) {
    const then = baseline.areas[area];
    const share = now.lines ? ((now.duplicatedLines / now.lines) * 100).toFixed(2) : '0.00';
    rows.push(
      `| ${area} | ${now.sources} | ${now.lines} | ${now.clones} | ${now.duplicatedLines} | ${share}% | ${then ? then.duplicatedLines : 'none'} |`,
    );
    if (!then) violations.push(`${area}: no baseline`);
    else if (now.duplicatedLines > then.duplicatedLines) {
      violations.push(
        `${area}: ${now.duplicatedLines} duplicated lines, baseline ${then.duplicatedLines} — see duplication-report/${area}/jscpd-report.json`,
      );
    }
  }
  const table = [
    `jscpd ${version}, at least ${MIN_TOKENS} tokens; locale JSON is not measured.`,
    '',
    '| Area | Files | Code lines | Clones | Duplicated lines | Share | Baseline |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
  console.log(table);
  writeFileSync(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify({ detector: `jscpd ${version}`, minTokens: MIN_TOKENS, areas: measured }, null, 2)}\n`,
  );
  return { table, violations };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { table, violations } = main();
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Duplication\n\n${table}\n\n`);
  }
  if (violations.length > 0) {
    console.error(`Duplication grew:\n${violations.map((item) => `- ${item}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('No area has more duplicated lines than its baseline.');
  }
}
