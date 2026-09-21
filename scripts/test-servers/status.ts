import { connect } from 'node:net';
import {
  baselineCompose,
  docker,
  dockerRunning,
  loadServers,
  matrixCompose,
  printServers,
} from './matrix.ts';

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

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 1000 });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

const port = (address: string) => Number(/:(\d+)/.exec(address)?.[1]);

const withDocker = dockerRunning();
if (!withDocker) console.log('Docker is not running; only host servers (IIS) are checked.\n');
const matrix = withDocker ? containers(['-f', matrixCompose, '--profile', '*']) : [];
const baseline = withDocker ? containers(['-f', baselineCompose]) : [];
// IIS is not a container: a server counts as up when its port accepts.
const servers = loadServers();
const iis = (
  await Promise.all(
    servers
      .filter((server) => server.profile === 'iis')
      .map(async (server) => ((await accepts(port(server.address))) ? server : undefined)),
  )
).filter((server) => server !== undefined);

if (matrix.length + baseline.length + iis.length === 0) {
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
const running = servers.filter((server) => {
  if (server.profile === 'iis') return iis.includes(server);
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
