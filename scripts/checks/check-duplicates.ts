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

/**
 * `source` split into what production builds compile and what only tests
 * compile. Both keep every line, blank where the other half is, so a clone's
 * line numbers still point into the real file.
 */
export function splitInlineTests(source: string): { production: string; tests: string } {
  const ranges = inlineTestRanges(source);
  const production = source.split('');
  const tests = source.split('');
  let cursor = 0;
  for (const [start, end] of ranges) {
    blank(tests, cursor, start);
    blank(production, start, end);
    cursor = end;
  }
  blank(tests, cursor, source.length);
  return { production: production.join(''), tests: tests.join('') };
}

function blank(chars: string[], start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n') chars[index] = ' ';
  }
}

/** Offsets of every item marked `#[cfg(test)]`, attribute included. */
function inlineTestRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /#\[cfg\(test\)\]/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (!isCode(source, match.index)) continue;
    const end = itemEnd(source, match.index + match[0].length);
    ranges.push([match.index, end]);
    pattern.lastIndex = end;
  }
  return ranges;
}

/** Whether `offset` is outside comments and literals. */
function isCode(source: string, offset: number): boolean {
  let code = true;
  scan(source, 0, (index, inCode) => {
    if (index === offset) {
      code = inCode;
      return true;
    }
    return false;
  });
  return code;
}

/** Where the item starting at `from` ends: after its `;` or its closing `}`. */
function itemEnd(source: string, from: number): number {
  let depth = 0;
  let end = source.length;
  scan(source, from, (index, inCode) => {
    if (!inCode) return false;
    const char = source[index];
    // Other attributes on the same item, `#[...]`, keep brackets balanced
    // and never contain the item's own `;` or `{`.
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (depth === 0 && char === ';') {
      end = index + 1;
      return true;
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        // `use a::{b, c};` goes on to its semicolon; a block item ends here.
        const semicolon = /^\s*;/.exec(source.slice(index + 1));
        end = index + 1 + (semicolon ? semicolon[0].length : 0);
        return true;
      }
    }
    return false;
  });
  return end;
}

/**
 * Walks `source` from `from`, calling `visit(index, inCode)` per character
 * until it returns true. Skips line and block comments, string, raw string
 * and byte string literals and char literals; a `'` that opens a lifetime is
 * code.
 */
function scan(source: string, from: number, visit: (_index: number, _inCode: boolean) => boolean) {
  let index = from;
  const skip = (to: number) => {
    for (; index < to && index < source.length; index += 1) {
      if (visit(index, false)) return true;
    }
    return false;
  };
  while (index < source.length) {
    const rest = source.slice(index, index + 3);
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', index);
      if (skip(end < 0 ? source.length : end)) return;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 0;
      let end = index;
      do {
        if (source.startsWith('/*', end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith('*/', end)) {
          depth -= 1;
          end += 2;
        } else end += 1;
      } while (depth > 0 && end < source.length);
      if (skip(end)) return;
      continue;
    }
    const raw = /^b?r(#*)"/.exec(source.slice(index, index + 260));
    if (raw && (index === 0 || !/[\w]/.test(source[index - 1]!))) {
      const closing = `"${raw[1]}`;
      const end = source.indexOf(closing, index + raw[0].length);
      if (skip(end < 0 ? source.length : end + closing.length)) return;
      continue;
    }
    if (source[index] === '"' || (source[index] === 'b' && source[index + 1] === '"')) {
      let end = source.indexOf('"', index) + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      if (skip(end + 1)) return;
      continue;
    }
    if (source[index] === "'") {
      const char = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/u.exec(
        source.slice(index, index + 12),
      );
      if (char) {
        if (skip(index + char[0].length)) return;
        continue;
      }
    }
    if (visit(index, true)) return;
    index += 1;
  }
}

function listFiles(directory: string, keep: (_file: string) => boolean): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(keep);
}

const isTestFile = (file: string) => /(^|[\\/])(tests|[\w]+_tests)\.rs$/.test(file);

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
