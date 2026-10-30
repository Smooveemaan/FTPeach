import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Build Docker's arguments without relying on shell-specific path expansion. */
export function sastDockerArgs(root: string): string[] {
  return [
    'run',
    '--rm',
    '-v',
    `${root}:/src`,
    '-w',
    '/src',
    'semgrep/semgrep:1.176.1',
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
  ];
}

if (import.meta.filename === process.argv[1]) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const result = spawnSync('docker', sastDockerArgs(root), { stdio: 'inherit' });
  if (result.error) console.error(`Could not run Docker: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
