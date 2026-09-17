import { baselineCompose, docker, matrixCompose } from './matrix.ts';

// Stops every matrix profile. --volumes also deletes the seeded fixtures and the
// Nextcloud installation; --baseline also stops the existing CI stack.
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--volumes' && arg !== '--baseline') {
    console.error('Usage: npm run servers:down -- [--volumes] [--baseline]');
    process.exit(2);
  }
}
const volumes = args.has('--volumes') ? ['--volumes'] : [];

docker(['compose', '-f', matrixCompose, '--profile', '*', 'down', '--remove-orphans', ...volumes]);
if (args.has('--baseline')) {
  docker(['compose', '-f', baselineCompose, 'down', ...volumes]);
}
