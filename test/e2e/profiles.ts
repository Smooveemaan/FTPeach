// The profile fixtures of test/fixtures/profiles as the files a test puts in
// place, with their placeholders filled in (see the README there).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Server } from './panes.ts';
import { ftpServer, hostKeyFingerprint, sftpServer } from './servers.ts';

export const fixtures = path.resolve(import.meta.dirname, '../fixtures/profiles');

/** DPAPI for the account running the test, with the entropy FTPeach uses (security/dpapi.rs). */
function dpapi(text: string) {
  return execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:SECRET), [Text.Encoding]::ASCII.GetBytes('FTPeach/dpapi-entropy/v1'), 'CurrentUser'))",
    ],
    { encoding: 'utf8', env: { ...process.env, SECRET: text } },
  ).trim();
}

const serverValues = (name: string, server: Server) => ({
  [`$${name}.host`]: server.host,
  [`$${name}.port`]: Number(server.port),
  [`$${name}.user`]: server.user,
  [`$${name}.password`]: server.password,
});

/** What each placeholder of test/fixtures/profiles/README.md stands for. */
function placeholders(): Record<string, string | number> {
  return {
    ...serverValues('ftp', ftpServer),
    ...serverValues('sftp', sftpServer),
    '$sftp.address': `${sftpServer.host}:${sftpServer.port}`,
    // Read only by a profile that names it: the key file is there only on a
    // stand with the SSH server installed.
    get '$sftp.fingerprint'() {
      return hostKeyFingerprint();
    },
    $fixtures: fixtures,
  };
}

function expand(value: unknown, values: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('$dpapi:')) return dpapi(String(expand(value.slice(7), values)));
    return value in values ? values[value] : value;
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(expand(key, values)),
        expand(item, values),
      ]),
    );
  }
  return value;
}

/** The files of a fixture profile, by name: JSON with its placeholders filled in, the rest as it is. */
export function profile(name: string): Record<string, string | Buffer> {
  const folder = path.join(fixtures, name);
  const values = placeholders();
  return Object.fromEntries(
    readdirSync(folder).map((file) => {
      const bytes = readFileSync(path.join(folder, file));
      return [
        file,
        file.endsWith('.json')
          ? JSON.stringify(expand(JSON.parse(bytes.toString('utf8')), values))
          : bytes,
      ];
    }),
  );
}
