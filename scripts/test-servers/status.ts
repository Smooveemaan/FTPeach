import { baselineCompose, docker, loadServers, matrixCompose, printServers } from './matrix.ts';

interface ComposeContainer {
  Service: string;
  State: string;
  Health: string;
  Status: string;
}

function containers(args: string[]): ComposeContainer[] {
  // `ps --format json` prints one JSON object per line.
  return docker(['compose', ...args, 'ps', '--all', '--format', 'json'], { capture: true })
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposeContainer);
}

const matrix = containers(['-f', matrixCompose, '--profile', '*']);
const baseline = containers(['-f', baselineCompose]);

if (matrix.length + baseline.length === 0) {
  console.log('No test servers are running. Start some with: npm run servers:up -- <profile...>');
  process.exit(0);
}

for (const [title, list] of [
  ['matrix', matrix],
  ['baseline', baseline],
] as const) {
  if (list.length === 0) continue;
  console.log(`${title}:`);
  for (const container of list) {
    console.log(`  ${container.Service.padEnd(26)} ${container.Status}`);
  }
}

const healthy = new Set(
  [...matrix, ...baseline]
    .filter((container) => container.State === 'running' && container.Health !== 'unhealthy')
    .map((container) => container.Service),
);
const running = loadServers().filter((server) => {
  if (server.profile === 'baseline') {
    return baseline.some(
      (container) => container.Service === server.service && container.State === 'running',
    );
  }
  return (
    matrix.some((container) => container.Service === server.service) && healthy.has(server.service)
  );
});
if (running.length > 0) {
  console.log('');
  printServers(running);
}
