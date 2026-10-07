// Runs the server matrix one scenario at a time, each in its own test process
// with its own time limit, and writes a per-server report. A scenario that
// hangs (a stuck FTPS data connection keeps its server's lock) then costs one
// group, not the whole run. Used by .github/workflows/server-matrix.yml; runs
// locally the same way against servers started with `npm run servers:up`.
//
//   npm run servers:ci -- <profile...> [--only <test path prefix>]... [--minutes N]
//
// The report goes to $GITHUB_STEP_SUMMARY when set, and to stdout.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Outcome = 'passed' | 'failed' | 'not run' | 'not selected' | 'timed out';

/**
 * Tests allowed to report NOT RUN although their servers are selected, each
 * with the reason. Any other NOT RUN fails the run: a scenario that skipped
 * itself proves nothing.
 */
export const EXPECTED_NOT_RUN: ReadonlyArray<{
  test: RegExp;
  when: (_platform: typeof process.platform) => boolean;
  why: string;
}> = [
  {
    test: /^specific::\w+_active_mode$/,
    when: (platform) => platform !== 'linux',
    why: 'Docker Desktop routes neither way between the host and a container, so active-mode FTP runs on Linux only',
  },
];

/**
 * What each member of one test run did, read from its libtest output.
 * support::not_run and support::not_selected name the test they skipped. With
 * --nocapture, the tests' own lines land between libtest's `test <name> ... `
 * and its result, or right after the result: `test a ... okNOT RUN [b]: ...`.
 */
export function outcomesOf(
  output: string,
  members: readonly string[],
  timedOut: boolean,
): Map<string, Outcome> {
  const named = (marker: string) =>
    new Set(
      [...output.matchAll(new RegExp(`${marker} \\[(\\S+)\\]`, 'g'))].map(
        (match) => match[1] ?? '',
      ),
    );
  const notRun = named('NOT RUN');
  const notSelected = named('NOT SELECTED');
  const outcomes = new Map<string, Outcome>();
  for (const name of members) {
    const line = new RegExp(
      `^test ${name.replaceAll(':', '\\:')} \\.\\.\\. (?:(?!test )[^\\n]*\\n)*?(ok|FAILED|ignored)`,
      'm',
    ).exec(output);
    if (line?.[1] === 'ok') {
      outcomes.set(
        name,
        notSelected.has(name) ? 'not selected' : notRun.has(name) ? 'not run' : 'passed',
      );
    } else if (line) {
      outcomes.set(name, 'failed');
    } else {
      outcomes.set(name, timedOut ? 'timed out' : 'failed');
    }
  }
  return outcomes;
}

/** The outcomes that fail the run, with the outcome each one had. */
export function failuresOf(
  outcomes: ReadonlyMap<string, Outcome>,
  platform: typeof process.platform,
): Array<[string, Outcome]> {
  return [...outcomes].filter(([name, outcome]) => {
    if (outcome === 'failed' || outcome === 'timed out') return true;
    if (outcome !== 'not run') return false;
    return !EXPECTED_NOT_RUN.some(
      (expected) => expected.test.test(name) && expected.when(platform),
    );
  });
}

/** The server a scenario runs against; the specific tests share one row. */
function serverOf(name: string): string {
  const parts = name.split('::');
  return parts[0] === 'specific' ? 'specific' : (parts[1] ?? name);
}

/** The Markdown report: a row per server this run selected, then what failed. */
export function reportOf(
  profiles: readonly string[],
  outcomes: ReadonlyMap<string, Outcome>,
  failures: ReadonlyArray<[string, Outcome]>,
): string {
  const byServer = new Map<string, Record<Exclude<Outcome, 'not selected'>, number>>();
  let notSelected = 0;
  for (const [name, outcome] of outcomes) {
    if (outcome === 'not selected') {
      notSelected++;
      continue;
    }
    const server = serverOf(name);
    const counts = byServer.get(server) ?? {
      passed: 0,
      failed: 0,
      'not run': 0,
      'timed out': 0,
    };
    counts[outcome]++;
    byServer.set(server, counts);
  }
  return [
    `### Server matrix: ${profiles.join(', ')}`,
    '',
    '| Server | Passed | Failed | Timed out | Not run |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...[...byServer]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([server, counts]) =>
          `| ${server} | ${counts.passed} | ${counts.failed} | ${counts['timed out']} | ${counts['not run']} |`,
      ),
    '',
    `${notSelected} test(s) belong to servers this run did not select and are left out.`,
    '',
    failures.length === 0
      ? 'No failures.'
      : ['Failed:', '', ...failures.map(([name, outcome]) => `- \`${name}\` (${outcome})`)].join(
          '\n',
        ),
    '',
  ].join('\n');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage =
  'Usage: npm run servers:ci -- <profile...> [--only <test path prefix>]... [--minutes N]';

/**
 * Runs servers:test with libtest arguments; stdout and stderr together. On
 * the time limit the whole tree goes (node, cargo, the test binary): killing
 * only the child would leave the test binary holding the servers.
 */
function matrix(
  profiles: readonly string[],
  testArgs: string[],
  timeoutMs?: number,
): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/test-servers/test.ts',
        ...profiles,
        '--',
        ...testArgs,
      ],
      { cwd: root, detached: process.platform !== 'win32' },
    );
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            } else if (child.pid !== undefined) {
              process.kill(-child.pid, 'SIGKILL');
            }
          }, timeoutMs);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ output, timedOut });
    });
  });
}

async function main() {
  const profiles: string[] = [];
  const only: string[] = [];
  let minutes = 20;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--only' || arg === '--minutes') {
      const value = args[++index];
      if (!value) {
        console.error(usage);
        process.exit(2);
      }
      if (arg === '--only') only.push(value);
      else minutes = Number(value);
    } else {
      profiles.push(arg);
    }
  }
  if (profiles.length === 0 || !(minutes > 0)) {
    console.error(usage);
    process.exit(2);
  }

  // `name: test` lines; building happens here, once, before any time limit.
  const listed = (await matrix(profiles, ['--list'])).output;
  const tests = [...listed.matchAll(/^(\S+): test$/gm)]
    .map((match) => match[1] ?? '')
    .filter((name) => only.length === 0 || only.some((prefix) => name.startsWith(prefix)));
  if (tests.length === 0) {
    console.error('No matrix tests matched; did the build fail?');
    process.exit(1);
  }

  // common::vsftpd::s04_transfer -> group s04_transfer, run across every server;
  // specific::* tests are independent, so each module runs as one group.
  const groups = new Map<string, string[]>();
  for (const name of tests) {
    const parts = name.split('::');
    const group = parts[0] === 'specific' ? 'specific::' : `::${parts.at(-1)}`;
    groups.set(group, [...(groups.get(group) ?? []), name]);
  }

  const outcomes = new Map<string, Outcome>();
  for (const [group, members] of groups) {
    // --exact with every member keeps a prefix like `s01` from matching `s010`.
    const run = await matrix(profiles, ['--exact', '--nocapture', ...members], minutes * 60_000);
    for (const [name, outcome] of outcomesOf(run.output, members, run.timedOut)) {
      outcomes.set(name, outcome);
    }
    if (run.timedOut) console.error(`\n${group}: stopped after ${minutes} min`);
  }

  const failures = failuresOf(outcomes, process.platform);
  const report = reportOf(profiles, outcomes, failures);
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.filename === process.argv[1]) await main();
