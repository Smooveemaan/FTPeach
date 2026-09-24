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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage =
  'Usage: npm run servers:ci -- <profile...> [--only <test path prefix>]... [--minutes N]';

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

/**
 * Runs servers:test with libtest arguments; stdout and stderr together. On
 * the time limit the whole tree goes (node, cargo, the test binary): killing
 * only the child would leave the test binary holding the servers.
 */
function matrix(
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

// `name: test` lines; building happens here, once, before any time limit.
const listed = (await matrix(['--list'])).output;
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

type Outcome = 'passed' | 'failed' | 'not run' | 'timed out';
const outcomes = new Map<string, Outcome>();
for (const [group, members] of groups) {
  // --exact with every member keeps a prefix like `s01` from matching `s010`.
  const run = await matrix(['--exact', '--nocapture', ...members], minutes * 60_000);
  // support::not_run names the test it skipped.
  const notRun = new Set(
    [...run.output.matchAll(/^NOT RUN \[(\S+)\]/gm)].map((match) => match[1] ?? ''),
  );
  for (const name of members) {
    const line = new RegExp(`^test ${name.replaceAll(':', '\\:')} \\.\\.\\. (\\w+)`, 'm').exec(
      run.output,
    );
    if (line?.[1] === 'ok') {
      outcomes.set(name, notRun.has(name) ? 'not run' : 'passed');
    } else if (line) {
      outcomes.set(name, 'failed');
    } else {
      outcomes.set(name, run.timedOut ? 'timed out' : 'failed');
    }
  }
  if (run.timedOut) console.error(`\n${group}: stopped after ${minutes} min`);
}

/** The server a scenario runs against; the specific tests share one row. */
function serverOf(name: string): string {
  const parts = name.split('::');
  return parts[0] === 'specific' ? 'specific' : (parts[1] ?? name);
}

const byServer = new Map<string, Record<Outcome, number>>();
for (const [name, outcome] of outcomes) {
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

const failures = [...outcomes].filter(
  ([, outcome]) => outcome === 'failed' || outcome === 'timed out',
);
const report = [
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
  failures.length === 0
    ? 'No failures.'
    : ['Failed:', '', ...failures.map(([name, outcome]) => `- \`${name}\` (${outcome})`)].join(
        '\n',
      ),
  '',
].join('\n');
console.log(`\n${report}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
process.exit(failures.length === 0 ? 0 : 1);
