import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SEMGREP_IMAGE =
  'semgrep/semgrep@sha256:34ab619bf1391a24bfda3f05debd0d8a6ce3093c2d5f9d39cfc00f83c1397823'; // 1.176.1
const FIXTURES = ['.semgrep/security.rs', '.semgrep/security.tsx'];

type SastResult = {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
};

type RunDocker = (_command: string, _args: string[], _options: { encoding: 'utf8' }) => SastResult;

function dockerArgs(root: string, semgrepArgs: string[]): string[] {
  return ['run', '--rm', '-v', `${root}:/src`, '-w', '/src', SEMGREP_IMAGE, ...semgrepArgs];
}

export function sastFixtureDockerArgs(root: string, fixture: string): string[] {
  return dockerArgs(root, [
    'semgrep',
    'scan',
    '--test',
    '--config',
    '.semgrep/security.yml',
    fixture,
    '--metrics=off',
    '--disable-version-check',
  ]);
}

/** Build Docker's arguments without relying on shell-specific path expansion. */
export function sastDockerArgs(root: string): string[] {
  return dockerArgs(root, [
    'semgrep',
    'scan',
    '--config',
    '.semgrep/security.yml',
    '--error',
    '--strict',
    '--metrics=off',
    '--disable-version-check',
    'src-tauri/src',
    'src',
  ]);
}

export function runSast(root: string, run: RunDocker = spawnSync): number {
  for (const fixture of FIXTURES) {
    const result = run('docker', sastFixtureDockerArgs(root, fixture), { encoding: 'utf8' });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.error) console.error(`Could not run Docker: ${result.error.message}`);
    if (result.status !== 0) return result.status ?? 1;
    if (!`${result.stdout}\n${result.stderr}`.includes('All tests passed')) {
      console.error(`SAST fixtures did not run successfully: ${fixture}`);
      return 1;
    }
  }

  const result = run('docker', sastDockerArgs(root), { encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) console.error(`Could not run Docker: ${result.error.message}`);
  return result.status ?? 1;
}

if (import.meta.filename === process.argv[1]) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  process.exit(runSast(root));
}
