import { runPackagedSmoke } from './harness.ts';

await runPackagedSmoke();
console.log('OK: packaged FTPeach smoke test passed');
await runPackagedSmoke({ portable: true });
console.log('OK: portable FTPeach smoke test passed');
