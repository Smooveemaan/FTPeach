import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface SecretCandidate {
  path: string;
  content?: string | undefined;
}

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
const safeContentFragments: Record<string, string[]> = {
  'scripts/checks/check-tracked-secrets.ts': [
    '/untrusted comment: rsign encrypted secret key/i,',
    `'untrusted comment: rsign encrypted secret key',`,
  ],
  'scripts/release/release-trust.ts': [`'untrusted comment: rsign encrypted secret key',`],
};

export function secretViolations(candidates: Iterable<SecretCandidate>): string[] {
  const violations: string[] = [];
  for (const candidate of candidates) {
    const path = candidate.path.replaceAll('\\', '/');
    const suspiciousPath =
      secretPathPatterns.some((pattern) => pattern.test(path)) &&
      !allowedExamplePatterns.some((pattern) => pattern.test(path));
    if (suspiciousPath) violations.push(`${path} (secret-like filename)`);
    let content = candidate.content;
    for (const fragment of safeContentFragments[path] ?? []) {
      if (content !== undefined) content = content.replaceAll(fragment, '');
    }
    if (content !== undefined && secretContentPatterns.some((pattern) => pattern.test(content))) {
      violations.push(`${path} (private-key marker)`);
    }
  }
  return [...new Set(violations)];
}

function main(): void {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const candidates = tracked.flatMap((path) => {
    if (!existsSync(path)) return [];
    let content: string | undefined;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      // Binary and unreadable files still get the filename check.
    }
    return [{ path, content }];
  });
  const violations = secretViolations(candidates);

  if (violations.length > 0) {
    console.error('Tracked secret candidates found:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Tracked-secret check OK: ${tracked.length} file(s) inspected`);
  }
}

if (import.meta.filename === process.argv[1]) {
  main();
}
