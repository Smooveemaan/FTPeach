import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProfiles, profiles } from './matrix.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage = [
  'Usage: npm run servers:test -- [profile...] [-- test filter and libtest flags]',
  `Profiles: ${profiles.join(', ')}, iis, all. None selects every target except iis.`,
  'FTPEACH_MATRIX_TARGETS=vsftpd,dropbear selects single servers instead.',
].join('\n');

const separator = process.argv.indexOf('--', 2);
const profileArgs = process.argv.slice(2, separator === -1 ? undefined : separator);
const testArgs = separator === -1 ? [] : process.argv.slice(separator + 1);
const selected = parseProfiles(profileArgs, usage);
const env = { ...process.env };
if (selected.length > 0) env.FTPEACH_MATRIX = selected.join(',');

const result =
  process.platform === 'win32'
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(root, 'scripts/with-libsodium.ps1'),
          '-Command',
          'server-matrix',
          ...testArgs,
        ],
        { stdio: 'inherit', env, cwd: root },
      )
    : spawnSync(
        'cargo',
        [
          'test',
          '--locked',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          '--features',
          'test-utils',
          '--test',
          'server_matrix',
          '--',
          '--ignored',
          ...testArgs,
        ],
        { stdio: 'inherit', env, cwd: root },
      );
if (result.error) throw result.error;
process.exit(result.status ?? 1);
