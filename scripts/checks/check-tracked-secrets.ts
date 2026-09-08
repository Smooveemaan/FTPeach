import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const secretPathPatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|$)/i,
  /\.(?:key|pem|p12|pfx)$/i,
];
const allowedExamplePatterns = [/\.env\.(?:example|sample|template)$/i];
const secretContentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{32,}={0,2}\r?\n)+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /untrusted comment: rsign encrypted secret key/i,
];

const violations = [];

for (const path of tracked) {
  // The scanner necessarily contains the markers it searches for.
  if (path === 'scripts/checks/check-tracked-secrets.ts') continue;

  if (!existsSync(path)) continue;

  const suspiciousPath =
    secretPathPatterns.some((pattern) => pattern.test(path)) &&
    !allowedExamplePatterns.some((pattern) => pattern.test(path));
  if (suspiciousPath) violations.push(`${path} (secret-like filename)`);

  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (secretContentPatterns.some((pattern) => pattern.test(content))) {
    violations.push(`${path} (private-key marker)`);
  }
}

if (violations.length > 0) {
  console.error('Tracked secret candidates found:');
  for (const violation of new Set(violations)) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Tracked-secret check OK: ${tracked.length} file(s) inspected`);
}
