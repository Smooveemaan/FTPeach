import {
  baselineCompose,
  docker,
  loadServers,
  matrixCompose,
  matrixProfiles,
  parseProfiles,
  printServers,
} from './matrix.ts';

const usage = [
  'Usage: npm run servers:up -- <profile...>',
  `Profiles: ${matrixProfiles.join(', ')}, baseline, iis (host, prints how to install), all (everything except heavy, chaos and iis)`,
  'FTPEACH_MATRIX_BIG_MB sets the size of fixtures/sizes/big.bin (default 64).',
].join('\n');

const selected = parseProfiles(process.argv.slice(2), usage);
if (selected.length === 0) {
  console.error(usage);
  process.exit(2);
}

if (selected.includes('baseline')) {
  docker(['compose', '-f', baselineCompose, 'up', '--detach', '--wait']);
}

if (selected.includes('iis')) {
  console.log(
    'IIS runs on the Windows host, not in Docker. Install it once from an elevated PowerShell:\n' +
      '  scripts/test-servers/iis.ps1 install\n',
  );
}

const matrix = selected.filter((profile) => profile !== 'baseline' && profile !== 'iis');
if (matrix.length > 0) {
  docker([
    'compose',
    '-f',
    matrixCompose,
    ...matrix.flatMap((profile) => ['--profile', profile]),
    'up',
    '--detach',
    '--build',
    '--wait',
    // Nextcloud installs itself and indexes the fixtures on first start.
    '--wait-timeout',
    selected.includes('heavy') ? '1200' : '300',
  ]);
}

console.log('');
printServers(loadServers().filter((server) => selected.includes(server.profile)));
console.log('\nTLS test CA and client keys: src-tauri/tests/docker/matrix/generated/');
