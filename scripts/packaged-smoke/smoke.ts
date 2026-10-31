import { runPackagedSmoke } from './harness.ts';

await runPackagedSmoke();
console.log('OK: packaged FTPeach smoke test passed');
if (process.platform === 'win32') {
  await runPackagedSmoke({ portable: true });
  console.log('OK: portable FTPeach smoke test passed');
}
