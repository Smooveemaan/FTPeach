import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const matrixCompose = path.join(root, 'src-tauri/tests/docker/matrix/docker-compose.yml');
export const baselineCompose = path.join(root, 'src-tauri/tests/docker/docker-compose.yml');

export const matrixProfiles = ['ftp', 'sftp', 'webdav', 'heavy', 'proxy', 'chaos'] as const;
export const profiles = [...matrixProfiles, 'baseline'] as const;
// `iis` is catalog-only: those servers run on the Windows host (iis.ps1).
export type Profile = (typeof profiles)[number] | 'iis';

export interface MatrixServer {
  id: string;
  profile: Profile;
  service: string;
  protocol: string;
  address: string;
  user: string;
  password: string;
  notes: string;
}

export function loadServers(): MatrixServer[] {
  const catalog = JSON.parse(
    readFileSync(path.join(root, 'src-tauri/tests/docker/matrix/servers.json'), 'utf8'),
  ) as { servers: MatrixServer[] };
  return catalog.servers;
}

/** Expands `all` and validates profile names; exits with usage on anything unknown. */
export function parseProfiles(args: string[], usage: string): Profile[] {
  const selected = new Set<Profile>();
  for (const arg of args) {
    if (arg === 'all') {
      // heavy (Nextcloud) and chaos stay opt-in even for "all": both are slow.
      for (const profile of ['ftp', 'sftp', 'webdav', 'proxy', 'baseline'] as const) {
        selected.add(profile);
      }
    } else if (arg === 'iis') {
      console.error(
        'IIS runs on the Windows host, not in Docker. From an elevated PowerShell:\n' +
          '  scripts/test-servers/iis.ps1 install',
      );
      process.exit(2);
    } else if ((profiles as readonly string[]).includes(arg)) {
      selected.add(arg as Profile);
    } else {
      console.error(`Unknown profile "${arg}".\n${usage}`);
      process.exit(2);
    }
  }
  return [...selected];
}

export function dockerRunning(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

export function docker(args: string[], options: { capture?: boolean } = {}): string {
  const result = spawnSync('docker', args, {
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\ndocker ${args.join(' ')} exited with ${result.status ?? 'a signal'}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

export function printServers(servers: MatrixServer[]): void {
  const rows = servers.map((server) => [
    server.id,
    server.protocol,
    server.address,
    server.user ? `${server.user} / ${server.password || '(key)'}` : '-',
    server.notes,
  ]);
  const header = ['server', 'protocol', 'address', 'login', 'notes'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ');
  console.log(format(header));
  console.log(format(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(format(row));
}
